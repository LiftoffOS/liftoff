// Rubric-generation and scoring prompts for the deliverable grader.
//
// The *_PROMPT_VERSION strings are stamped on every rubric/grade row so the
// calibration cohorts can separate scores produced under different prompts.
// Prompt CONTENT is expected to be tuned by the eval owner over time.

export const RUBRIC_PROMPT_VERSION = 'rubric-v1';
export const SCORE_PROMPT_VERSION = 'score-v1';
export const SCORE_AGENTIC_PROMPT_VERSION = 'score-agentic-v1';

export const RUBRIC_SYSTEM = `You design grading rubrics for completed AI-agent work sessions.
Given the task objective, the conversation, and the produced deliverables, output a JSON rubric
partitioning evaluation into weighted top-level categories: correctness_accuracy,
deliverable_completeness, task_requirements, technical_quality (add a category only if clearly
needed; at most 6 categories, at most 10 items per category). Category weights sum to 1.0.
Each item: criterion (one testable statement, <=300 chars), points (integer 1-100),
verification (the concrete checking procedure, <=500 chars). Do not reference information
unavailable in the session. Output ONLY JSON:
{"categories":[{"name":"...","weight":0.4,"items":[{"criterion":"...","points":40,"verification":"..."}]}]}`;

export const SCORE_SYSTEM = `You are one of several independent graders of a completed AI-agent
work session. You are given the objective, the deliverables, and a rubric whose items carry ids.
For EVERY item id, follow its verification procedure and award 0..points (partial credit allowed,
note why). Unverifiable = 0 with note "unverifiable". Output ONLY JSON:
{"items":[{"id":"c0.i0","awarded":<n>,"note":"..."}]}`;

export const SCORE_AGENTIC_SYSTEM = `You are one of several independent graders of a completed
AI-agent work session. You are given the objective, the deliverables, and a rubric whose items
carry ids. You have an isolated sandbox at /workspace plus file, shell, and web tools.
The captured deliverable files are ALREADY in /workspace (list them with file_glob); a file named
<name>.b64 is base64 — restore it with \`base64 -d /workspace/<name>.b64 > /workspace/<name>\`.
For EVERY item id, ACTIVELY carry out its verification procedure rather than guessing: inspect the
seeded files with file_read, run checks with shell_exec (e.g. parse a spreadsheet, execute the
script, unzip an archive), and test any links with web_fetch. Then award
0..points (partial credit allowed, note what you verified). If a procedure genuinely cannot be run,
award 0 with note "unverifiable". Do not modify the tenant's external systems; work only in the
sandbox. Your FINAL message must be ONLY the JSON, nothing else:
{"items":[{"id":"c0.i0","awarded":<n>,"note":"..."}]}`;
