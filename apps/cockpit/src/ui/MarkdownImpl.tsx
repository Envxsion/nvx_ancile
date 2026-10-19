/**
 * ------------------------------------------------------------------
 *  Title    |  Markdown chunk
 *  Ref      |  ROADMAP P1
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The one module that imports Streamdown, so the bundler
 *           |  keeps the markdown stack in its own chunk.
 *  Note     |  Reached only through ui/Markdown.tsx.
 * ------------------------------------------------------------------
 */

import { Streamdown } from 'streamdown';
import { REHYPE_PLUGINS, REMARK_PLUGINS, urlTransform } from '../thread/mdPlugins';
import type { MarkdownProps } from './Markdown';

export function Rendered({ plugins = 'default', ...props }: MarkdownProps) {
  return plugins === 'thread' ? (
    <Streamdown
      {...props}
      remarkPlugins={REMARK_PLUGINS}
      rehypePlugins={REHYPE_PLUGINS}
      urlTransform={urlTransform}
    />
  ) : plugins === 'remark' ? (
    <Streamdown {...props} remarkPlugins={REMARK_PLUGINS} />
  ) : (
    <Streamdown {...props} />
  );
}
