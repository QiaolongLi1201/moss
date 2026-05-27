# @dmoss/skills

Automatic skill distillation and learning for the Moss agent runtime.

## Features

- **Skill Distillation**: Automatically extract reusable skills from successful agent sessions
- **Confidence Scoring**: Multi-factor scoring based on tool usage patterns, error recovery, and verification
- **Skill Promotion**: Automatic promotion of high-confidence candidates to permanent skills
- **Conversation Learning**: Learn from user corrections and feedback during conversations
- **Validation**: Comprehensive skill validation with frontmatter schema enforcement

## Installation

```bash
npm install @dmoss/skills
```

## Usage

```typescript
import { SkillPipeline } from '@dmoss/skills';

const pipeline = new SkillPipeline({
  workspaceDir: './skills',
  autoPromoteHighConfidence: true,
});

// Process a session to extract skill candidates
const result = await pipeline.processSession(sessionId, messages);

// Check if a skill was promoted
if (result?.promoted) {
  console.log('Skill promoted:', result.promoted.skillId);
}
```

## API

- `SkillPipeline`: End-to-end skill extraction and promotion
- `SkillScorer`: Multi-factor confidence scoring
- `SkillDistiller`: Extract skill structure from sessions
- `SkillValidator`: Validate skill format and content
- `ConversationSkillLearner`: Learn from user feedback

## License

MIT
