import {marked} from 'marked';

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A site page body (Markdown from the app's one editor) as HTML. Raw HTML in the source is shown as text and a link with a
 *  scheme other than http(s), mailto or a relative path loses its target. */
export function renderPageMarkdown(body: string): string {
  const renderer = new marked.Renderer();
  renderer.html = ({text}) => escapeHtml(text);
  const link = renderer.link.bind(renderer);
  renderer.link = (token) => {
    const ok = /^(https?:|mailto:|\/|#)/i.test(token.href.trim());
    return link(ok ? token : {...token, href: '#'});
  };
  return marked.parse(body, {async: false, renderer}) as string;
}
