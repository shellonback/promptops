import type { Terminal, ILinkProvider, ILink } from '@xterm/xterm';

/**
 * xterm link provider that turns file-path-like tokens in CLI output into
 * clickable links, so the user can jump straight into the integrated code
 * editor (the WebLinksAddon only handles http/https/mailto URLs).
 *
 * The matcher is deliberately conservative: a token must contain at least one
 * path separator and end in a dotted extension. That filters out prose,
 * version numbers ("1.2.3"), and bare words while still catching the paths the
 * CLI prints — `src/index.ts`, `app/components/Foo.tsx`, `/Users/x/file.ts`.
 * An optional `:line[:col]` suffix (common in CLI output) is captured so it can
 * be stripped before the path is resolved.
 */
export const FILE_PATH_RE =
  /(?<![\w/.~-])(?:\.{1,2}\/|\/)?(?:[\w.@~-]+\/)+[\w.@~-]+\.[A-Za-z][\w]*(?::\d+(?::\d+)?)?/g;

/** Strip a trailing `:line` or `:line:col` suffix; returns the bare path. */
export function stripLineSuffix(token: string): string {
  return token.replace(/:\d+(?::\d+)?$/, '');
}

/**
 * Build an {@link ILinkProvider} that reports file-path links for each buffer
 * line and invokes `onActivate` with the bare path when one is clicked.
 */
export function createFileLinkProvider(
  terminal: Terminal,
  onActivate: (path: string) => void,
): ILinkProvider {
  return {
    provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void): void {
      const line = terminal.buffer.active.getLine(bufferLineNumber - 1);
      if (!line) {
        callback(undefined);
        return;
      }
      const text = line.translateToString(true);
      if (!text) {
        callback(undefined);
        return;
      }

      const links: ILink[] = [];
      FILE_PATH_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = FILE_PATH_RE.exec(text)) !== null) {
        const token = match[0];
        const startIndex = match.index;
        // xterm buffer ranges are 1-based and inclusive on both ends. Paths are
        // ASCII so the string index lines up 1:1 with the cell column.
        links.push({
          range: {
            start: { x: startIndex + 1, y: bufferLineNumber },
            end: { x: startIndex + token.length, y: bufferLineNumber },
          },
          text: token,
          activate: () => onActivate(stripLineSuffix(token)),
        });
      }

      callback(links.length ? links : undefined);
    },
  };
}
