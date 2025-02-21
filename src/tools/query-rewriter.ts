import { z } from 'zod';
import { TokenTracker } from "../utils/token-tracker";
import { SearchAction } from '../types';
import {ObjectGeneratorSafe} from "../utils/safe-generator";


const responseSchema = z.object({
  think: z.string().describe('Strategic reasoning about query complexity and search approach').max(500),
  queries: z.array(z.string().describe('keyword-based search query, 2-3 words preferred, total length < 30 characters'))
    .min(1)
    .max(3)
    .describe('Array of search keywords queries, orthogonal to each other')
});



function getPrompt(action: SearchAction): string {
  return `You are an expert search query generator. You optimize user queries into precise keyword combinations with strategic reasoning and appropriate search operators.

<rules>
1. Start with simple keyword extraction, preserve crucial qualifiers while removing fluff words
2. Use exact match quotes for specific phrases that must stay together
3. Split queries only when necessary for distinctly different aspects
4. Make the query resistant to SEO manipulation
5. When necessary, append <query-operators> at the end only when must needed


<query-operators>
A query can't only have operators; and operators can't be at the start a query;

- "phrase" : exact match for phrases
- +term : must include term; for critical terms that must appear
- -term : exclude term; exclude irrelevant or ambiguous terms
- filetype:pdf/doc : specific file type
- site:example.com : limit to specific site
- lang:xx : language filter (ISO 639-1 code)
- loc:xx : location filter (ISO 3166-1 code)
- intitle:term : term must be in title
- inbody:term : term must be in body text
</query-operators>

</rules>

<examples>
Input Query: What's the difference between ReactJS and Vue.js for building web applications?
<think>
This is a comparison query. User is likely looking for technical evaluation and objective feature comparisons, possibly for framework selection decisions. We'll split this into separate queries to capture both high-level differences and specific technical aspects.
</think>
Queries: [
  "react performance",
  "vue performance",
  "react vue comparison",
]

Input Query: How to fix a leaking kitchen faucet?
<think>
This is a how-to query seeking practical solutions. User likely wants step-by-step guidance and visual demonstrations for DIY repair. We'll target both video tutorials and written guides.
</think>
Output Queries: [
  "kitchen faucet leak repair",
  "faucet drip fix site:youtube.com",
  "how to repair faucet "
]

Input Query: What are healthy breakfast options for type 2 diabetes?
<think>
This is a health-specific informational query. User needs authoritative medical advice combined with practical meal suggestions. Splitting into medical guidelines and recipes will provide comprehensive coverage.
</think>
Output Queries: [
  "what to eat for type 2 diabetes",
  "type 2 diabetes breakfast guidelines",
  "diabetic breakfast recipes"
]

Input Query: Latest AWS Lambda features for serverless applications
<think>
This is a product research query focused on recent updates. User wants current information about specific technology features, likely for implementation purposes. We'll target official docs and community insights.
</think>
Output Queries: [
  "aws lambda features site:aws.amazon.com intitle:2025",
  "new features lambda serverless"
]
</examples>

Now, process this query:
Input Query: ${action.searchQuery}
Intention: ${action.think}
`;
}

const TOOL_NAME = 'queryRewriter';

export async function rewriteQuery(action: SearchAction, tracker?: TokenTracker): Promise<{ queries: string[] }> {
  try {
    const generator = new ObjectGeneratorSafe(tracker);
    const prompt = getPrompt(action);

    const result = await generator.generateObject({
      model: TOOL_NAME,
      schema: responseSchema,
      prompt,
    });

    console.log(TOOL_NAME, result.object.queries);
    return { queries: result.object.queries };
  } catch (error) {
    console.error(`Error in ${TOOL_NAME}`, error);
    throw error;
  }
}