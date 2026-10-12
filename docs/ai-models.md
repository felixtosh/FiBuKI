# Calling AI models

Moved out of `CLAUDE.md`. The model roles, the rule against inline model ids and the route overrides stay there; this is the calling pattern.

## Gemini via Vertex AI (Cloud Functions)

All Gemini calls use **Vertex AI** (not Google AI Studio). This provides:
- Service account auth (no API keys needed)
- Region: `europe-west1` (matches Firebase region)
- Project ID auto-detected from environment

**Pattern for new Gemini functions:**
```typescript
import { VertexAI } from "@google-cloud/vertexai";
import { MODELS } from "../utils/models";

const GEMINI_MODEL = MODELS.geminiLite;
const VERTEX_LOCATION = process.env.VERTEX_LOCATION || "europe-west1";

function getProjectId(): string {
  return process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "";
}

// Usage
const vertexAI = new VertexAI({ project: getProjectId(), location: VERTEX_LOCATION });
const model = vertexAI.getGenerativeModel({ model: GEMINI_MODEL });
const response = await model.generateContent({ contents: [{ role: "user", parts: [{ text: prompt }] }] });
```

**Key files using Gemini:**
- `functions/src/import/matchColumns.ts` - CSV column matching
- `functions/src/extraction/geminiParser.ts` - Document extraction
- `functions/src/precision-search/geminiSearchHelper.ts` - Email search queries
- `functions/src/matching/matchFilePartner.ts` - Partner matching

## Anthropic Claude (Chat/Agent)

Used for the main chat interface and LangGraph agent. Requires `ANTHROPIC_API_KEY`.
