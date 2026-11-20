# Reading fonts

Chinese, Latin and math typography are configured independently in shared `typography.css`, loaded by the sidebar, popup and settings pages.

- Chinese: locally installed Hiragino Sans GB W3/W6, restricted to CJK Unicode ranges.
- Latin: locally installed Optima Regular, Bold, Italic and Bold Italic, restricted to Latin and punctuation ranges.
- Math: separate bundled KaTeX fonts. Only the formula root uses `--font-math`; KaTeX retains control over its symbol, italic and size subfonts.
- Code: the dedicated monospace stack.

Proprietary system fonts are referenced only through CSS `local()` and are not distributed.
Devices without these fonts use the system sans-serif fallback.
