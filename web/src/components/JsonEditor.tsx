import { useMemo } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { json } from '@codemirror/lang-json';
import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

const theme = EditorView.theme({
  '&': {
    backgroundColor: 'var(--well)',
    color: 'var(--ink)',
    fontSize: '12px',
    borderRadius: 'var(--r-md)',
    border: '1px solid var(--line)',
  },
  '&.cm-focused': { outline: 'none', borderColor: 'var(--ink-faint)', boxShadow: '0 0 0 3px var(--focus-soft)' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.6' },
  '.cm-content': { padding: '10px 0', caretColor: 'var(--jelly)' },
  '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--ink-faint)', border: 'none', paddingLeft: '4px' },
  '.cm-activeLine': { backgroundColor: 'var(--well-2)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--ink-soft)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--focus-soft) !important',
  },
  '.cm-cursor': { borderLeftColor: 'var(--jelly)', borderLeftWidth: '2px' },
  '.cm-matchingBracket': { backgroundColor: 'var(--focus-soft)', outline: 'none' },
  '.cm-foldPlaceholder': { background: 'var(--well-2)', border: 'none', color: 'var(--ink-soft)' },
  '.cm-placeholder': { color: 'var(--ink-faint)' },
});

const highlight = HighlightStyle.define([
  { tag: t.propertyName, color: 'var(--syn-key)' },
  { tag: t.string, color: 'var(--syn-string)' },
  { tag: t.number, color: 'var(--syn-number)' },
  { tag: [t.bool, t.null], color: 'var(--syn-atom)' },
  { tag: [t.brace, t.squareBracket, t.separator, t.punctuation], color: 'var(--ink-faint)' },
]);

export function JsonEditor({ value, onChange, autoFocus, height = '240px', placeholder, readOnly }: {
  value: string;
  onChange?: (v: string) => void;
  autoFocus?: boolean;
  height?: string;
  placeholder?: string;
  readOnly?: boolean;
}) {
  const extensions = useMemo(() => [json(), theme, syntaxHighlighting(highlight), EditorView.lineWrapping], []);
  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      height={height}
      theme="none"
      autoFocus={autoFocus}
      placeholder={placeholder}
      readOnly={readOnly}
      extensions={extensions}
      basicSetup={{ foldGutter: true, highlightActiveLine: true, autocompletion: false, searchKeymap: true, lineNumbers: true }}
    />
  );
}
