# Taste (Continuously Learned by [CommandCode][cmd])

[cmd]: https://commandcode.ai/

# code-style
- Prefer simple, straightforward code over verbose runtime type guards; avoid defensive type-narrowing functions like `is*` guards when a simpler approach works. Confidence: 0.75
- Keep state management mutations simple and mutative rather than using immutable spread patterns that sacrifice readability. Confidence: 0.70

