import { RefreshCw } from "lucide-react";

interface MdxPreviewPaneProps {
  baseUrl: string | null;
  filePath: string | null;
  theme: "light" | "dark";
  revision: number;
  error: string | null;
  onRefresh: () => void;
}

export function MdxPreviewPane({
  baseUrl,
  filePath,
  theme,
  revision,
  error,
  onRefresh,
}: MdxPreviewPaneProps) {
  if (error) {
    return (
      <section className="preview-pane preview-empty">
        <p className="preview-error">{error}</p>
      </section>
    );
  }

  if (!filePath) {
    return (
      <section className="preview-pane preview-empty">
        <p>Open a `.md` or `.mdx` file from a folder to preview its rendered components.</p>
      </section>
    );
  }

  if (!baseUrl) {
    return (
      <section className="preview-pane preview-empty">
        <p>Starting local MDX renderer…</p>
      </section>
    );
  }

  const src = `${baseUrl}/preview?file=${encodeURIComponent(filePath)}&theme=${theme}&v=${revision}`;

  return (
    <section className="preview-pane">
      <div className="preview-toolbar">
        <span className="preview-label">Live MDX Preview</span>
        <button
          type="button"
          className="icon-btn icon-btn-sm"
          onClick={onRefresh}
          title="Recompile MDX & components"
        >
          <RefreshCw size={13} />
        </button>
      </div>
      <iframe
        key={`${filePath}-${theme}-${revision}`}
        className="preview-iframe"
        src={src}
        title="MDX Preview"
      />
    </section>
  );
}
