import { useMemo, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy } from 'lucide-react';

function CodeBlock({
  language,
  children,
}: {
  language?: string;
  children: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const text = useMemo(() => {
    let out = '';
    const extract = (node: ReactNode): void => {
      if (typeof node === 'string' || typeof node === 'number') out += node;
      else if (Array.isArray(node)) node.forEach(extract);
      else if (node && typeof node === 'object' && 'props' in node) {
        extract((node as { props: { children: ReactNode } }).props.children);
      }
    };
    extract(children);
    return out;
  }, [children]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* ignore */
    }
  };

  return (
    <>
      <div className="code-header">
        <span>{language || 'code'}</span>
        <button className="copy-code-btn" onClick={copy}>
          {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre>
        <code>{children}</code>
      </pre>
    </>
  );
}

const components: Components = {
  pre({ children }) {
    const child = children as { props?: { className?: string; children?: ReactNode } };
    const className = child?.props?.className ?? '';
    const language = className.replace('language-', '') || undefined;
    return <CodeBlock language={language}>{child?.props?.children}</CodeBlock>;
  },
  a({ children, href }) {
    return (
      <a href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    );
  },
};

export function Markdown({ content }: { content: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
