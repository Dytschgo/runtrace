import { useModelSlots } from '../lib/data';
import { modelIcon, toolIcon } from '../lib/icons';
import { seriesColor } from '../lib/modelColors';

/** A model's icon in its own colour, beside its name in ink. Colour follows the model, never its rank in a view. */
export function ModelName({ model, showName = true }: { model: string; showName?: boolean }) {
  const slots = useModelSlots();
  const Icon = modelIcon(model);
  return (
    <span className="model-name" title={showName ? undefined : model}>
      <Icon size={14} aria-hidden="true" style={{ color: seriesColor(slots.get(model)) }} />
      {showName ? <span className="mono">{model}</span> : <span className="sr-only">{model}</span>}
    </span>
  );
}

export function ToolName({ name }: { name: string }) {
  const Icon = toolIcon(name);
  return <span className="model-name"><Icon size={14} aria-hidden="true" /><span className="mono">{name}</span></span>;
}
