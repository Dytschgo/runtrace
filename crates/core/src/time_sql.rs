//! Time parsing stays in Rust. SQL compares integer instants without ICU.
use duckdb::{
    Connection,
    core::{DataChunkHandle, LogicalTypeId},
    ffi::duckdb_string_t,
    types::DuckString,
    vscalar::{ScalarFunctionSignature, VScalar},
    vtab::arrow::WritableVector,
};

struct Epoch<const DIVISOR: i64>;
impl<const DIVISOR: i64> VScalar for Epoch<DIVISOR> {
    type State = ();

    fn invoke(
        _: &(),
        input: &mut DataChunkHandle,
        output: &mut dyn WritableVector,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let source = input.flat_vector(0);
        let mut target = output.flat_vector();
        for row in 0..input.len() {
            let instant = if source.row_is_null(row as u64) {
                None
            } else {
                // The signature guarantees VARCHAR storage. Read only a valid
                // initialized row within this chunk; null slots are never read.
                let mut value = unsafe { source.as_mut_ptr::<duckdb_string_t>().add(row).read() };
                let mut value = DuckString::new(&mut value);
                crate::storage::parse_time(&value.as_str()).map(|t| t.timestamp_micros() / DIVISOR)
            };
            match instant {
                Some(value) => {
                    // BIGINT output, one initialized slot at a time. No slice
                    // or mutable reference aliases the validity-mask operations.
                    unsafe { target.as_mut_ptr::<i64>().add(row).write(value) };
                }
                None => target.set_null(row),
            }
        }
        Ok(())
    }

    fn signatures() -> Vec<ScalarFunctionSignature> {
        vec![ScalarFunctionSignature::exact(
            vec![LogicalTypeId::Varchar.into()],
            LogicalTypeId::Bigint.into(),
        )]
    }
}

pub fn register(conn: &Connection) -> duckdb::Result<()> {
    conn.register_scalar_function::<Epoch<1>>("runtrace_time_us")?;
    conn.register_scalar_function::<Epoch<1000>>("runtrace_epoch_ms")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn integer_instants_preserve_offsets_microseconds_nulls_and_legacy_dates() {
        let conn = Connection::open_in_memory().unwrap();
        register(&conn).unwrap();
        let values: Vec<Option<i64>> = conn.prepare("SELECT runtrace_time_us(t) FROM (VALUES (NULL),('invalid'),('1970-01-01T00:00:00Z'),('1970-01-01T01:00:00+01:00'),('1969-12-31T23:59:59.999999Z'),('1970-01-01T00:00:00.000001Z'),('1970-01-01'),('1970-01-01 00:00:00')) dates(t)").unwrap().query_map([],|r|r.get(0)).unwrap().collect::<duckdb::Result<_>>().unwrap();
        assert_eq!(
            values,
            [
                None,
                None,
                Some(0),
                Some(0),
                Some(-1),
                Some(1),
                Some(0),
                Some(0)
            ]
        );
        // A cloned query connection sees the registered functions, including
        // vectorized chunks containing a mix of null and valid strings.
        let read = conn.try_clone().unwrap();
        let (n, sum): (i64,i64) = read.query_row("SELECT count(*),sum(runtrace_time_us(CASE WHEN i%2=0 THEN '1970-01-01T00:00:00.000001Z' END)) FROM range(10000) t(i)",[],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
        assert_eq!((n, sum), (10000, 5000));
        assert_eq!(
            read.query_row(
                "SELECT runtrace_epoch_ms('1969-12-31T23:59:59.999999Z')",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
    }
}
