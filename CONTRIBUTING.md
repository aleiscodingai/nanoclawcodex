# Contributing

## Source Code Changes

**Accepted:** Bug fixes, security fixes, simplifications, reducing code.

**Not accepted:** Features, capabilities, compatibility, enhancements. These should be skills.

## Skills

A [skill](https://developers.openai.com/codex) is a markdown file in `.codex/skills/` that teaches Codex how to transform a NanoClaw installation.

A PR that contributes a skill should not modify any source files.

Your skill should contain the **instructions** Codex follows to add the feature—not pre-built code. See `/add-telegram` for a good example.

### Why?

Every user should have clean and minimal code that does exactly what they need. Skills let users selectively add features to their fork without inheriting code for features they don't want.

### Testing

Test your skill by running it on a fresh clone before submitting.
