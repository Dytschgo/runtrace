import { modelIcon, toolIcon } from '../lib/icons';

/** Model identity stays monochrome; chart lines and swatches carry series colour. */
export function ModelName({ model, showName = true }: { model: string; showName?: boolean }) {
  const Icon = modelIcon(model);
  return (
    <span className="model-name" title={showName ? undefined : model}>
      <Icon size={14} aria-hidden="true" />
      {showName ? <span className="mono">{model}</span> : <span className="sr-only">{model}</span>}
    </span>
  );
}

export function ToolName({ name }: { name: string }) {
  const Icon = toolIcon(name);
  return <span className="model-name"><Icon size={14} aria-hidden="true" /><span className="mono">{name}</span></span>;
}
