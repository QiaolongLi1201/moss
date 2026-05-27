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
import { SkillPipeline, SkillScorer } from '@dmoss/skills';

const pipeline = new SkillPipeline({
  skillsDir: './skills',
  autoPromote: true,
});

// Process a session to extract skill candidates
await pipeline.processSession(sessionId, messages);

// Score a skill candidate
const score = SkillScorer.score(candidate, {
  toolUsage: true,
  errorRecovery: true,
});

// Promote high-confidence skills
if (score.confidence > 0.8) {
  await pipeline.promote(candidateId);
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
