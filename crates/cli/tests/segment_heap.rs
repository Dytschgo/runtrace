//! Verify that the Windows program embeds its segment-heap setting.
//! Paired import attempts measured lower working set, without qualifying a complete import.
#![cfg(all(windows, target_env = "msvc", target_pointer_width = "64"))]

fn u16_at(bytes: &[u8], at: usize) -> usize {
    u16::from_le_bytes(bytes[at..at + 2].try_into().unwrap()) as usize
}
fn u32_at(bytes: &[u8], at: usize) -> usize {
    u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap()) as usize
}

/// The data of every RT_MANIFEST (type 24) resource, read from the PE resource directory.
fn manifests(image: &[u8]) -> Vec<Vec<u8>> {
    let pe = u32_at(image, 0x3c);
    assert_eq!(&image[pe..pe + 4], b"PE\0\0");
    let sections = u16_at(image, pe + 6);
    let optional = pe + 24;
    assert_eq!(u16_at(image, optional), 0x20b, "PE32+ image");
    let resource_rva = u32_at(image, optional + 112 + 2 * 8);
    assert_ne!(resource_rva, 0, "The program has no resource section");
    let table = optional + u16_at(image, pe + 20);
    let offset = |rva: usize| {
        (0..sections)
            .map(|i| table + i * 40)
            .find_map(|s| {
                let start = u32_at(image, s + 12);
                let size = u32_at(image, s + 8).max(u32_at(image, s + 16));
                (start..start + size)
                    .contains(&rva)
                    .then(|| rva - start + u32_at(image, s + 20))
            })
            .expect("Resource address outside every section")
    };
    let base = offset(resource_rva);
    let entries = |directory: usize| {
        let count = u16_at(image, directory + 12) + u16_at(image, directory + 14);
        (0..count)
            .map(|i| {
                let entry = directory + 16 + i * 8;
                (u32_at(image, entry), u32_at(image, entry + 4))
            })
            .collect::<Vec<_>>()
    };
    let mut found = Vec::new();
    for (kind, names) in entries(base) {
        if kind != 24 {
            continue;
        }
        assert!(names & 0x8000_0000 != 0);
        for (_, languages) in entries(base + (names & 0x7fff_ffff)) {
            assert!(languages & 0x8000_0000 != 0);
            for (_, leaf) in entries(base + (languages & 0x7fff_ffff)) {
                assert!(leaf & 0x8000_0000 == 0);
                let data = base + leaf;
                let start = offset(u32_at(image, data));
                found.push(image[start..start + u32_at(image, data + 4)].to_vec());
            }
        }
    }
    found
}

#[test]
fn windows_program_selects_the_segment_heap() {
    let image = std::fs::read(env!("CARGO_BIN_EXE_runtrace")).unwrap();
    let manifests = manifests(&image);
    assert_eq!(
        manifests.len(),
        1,
        "Exactly one embedded application manifest"
    );
    let text = String::from_utf8_lossy(&manifests[0]);
    assert!(text.contains("http://schemas.microsoft.com/SMI/2020/WindowsSettings"));
    assert!(
        text.contains(">SegmentHeap</"),
        "Manifest must select SegmentHeap"
    );
    // Execution level and virtualization stay as they were without a manifest.
    assert!(!text.contains("requestedExecutionLevel"));
}
