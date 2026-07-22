# Theme Color Conventions

Extensions in this repo use a consistent color language mapped to Pi's theme tokens. Follow these rules when building new extensions.

## Color Roles

| Token     | Role              | Used For                                      |
|-----------|-------------------|-----------------------------------------------|
| `success` | Primary value     | Token counts, hash fills, branch name, counts |
| `accent`  | Secondary value   | Percentages, tool names, token out counts     |
| `warning` | Punctuation/frame | Brackets `[]`, parens `()`, pipes `|`, cost   |
| `dim`     | Filler/spacing    | Dashes, labels ("in", "out"), separators      |
| `muted`   | Subdued text      | CWD name, fallback states                     |

## Examples

```
Context meter:  warning([) success(###) dim(---) warning(]) accent(30%)
Git branch:     dim(pi-vs-cc) warning(() success(main) warning())
Token stats:    success(1.2k) dim(in) accent(340) dim(out) warning($0.0042)
Tool tally:     accent(Bash) success(3) warning(|) accent(Read) success(7)
```

## Rationale

- **Green (success)** draws the eye to live values that change — counts, filled bars, branch
- **Cyan (accent)** highlights identifiers and secondary metrics — names, percentages
- **Yellow (warning)** frames structure — delimiters tell you where one value ends and the next begins
- **Dim** recedes into the background — labels and filler shouldn't compete for attention
