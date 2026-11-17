import { createHash } from 'crypto';
import { pool } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import type { DistillInput, DistillOutput } from './distill-service';

// Bump this string whenever:
//   - The distillation prompt structure changes (e.g., new injected sections), OR
//   - Any connector's listImplemented is flipped to true in connectors.ts
// computeCatalogVersion() only hashes connector keys+status, NOT listImplemented,
// so cache invalidation on listImplemented changes requires a manual version bump here.
//
// Version history:
//   v1 — initial. Pre-hybrid execution engine.
//   v2 — hybrid execution engine prompt rewrite: workflowSteps emission is now
//        a STEP 1 mechanical decision tree (was a soft "optional sixth artifact"
//        below the five text artifacts). Schema field description strengthened.
//        userMessage envelope reiterates the emission rule.
//   v3 — delegate_to_agent synthetic-catalog description now lists the required
//        toolInput shape (agent_id, objective, optional input_data) so the LLM
//        stops omitting agent_id. BPR worked example dropped the non-existent
//        google_sheets__append_row reference and shows how to use llm_reason
//        when no catalog tool covers a write step. toolName field description
//        explicitly says "do NOT invent tool names — use llm_reason when no
//        tool covers the responsibility".
//   v4 — AVAILABLE INTEGRATIONS lines now include the integration's stable id
//        (UUID) so the distill LLM can reference it directly when populating
//        delegate_to_agent.toolInput.agent_id. Without it the LLM had the
//        right field name but no value, defaulting to "<UNKNOWN>" placeholder.
//   v5 — Fix the multi-step branchy-workflow case (the Customer Support Rep
//        shape): v4 prompt let the LLM put a procedural
//        backbone into skills instead of workflowSteps. v5 makes "responsibilities
//        contains ## Workflows section" the dominant emit trigger ("you MUST
//        emit workflowSteps — no exceptions"), explicitly says branches +
//        conditional logic + intermediate runtime judgment are NOT reasons to
//        omit, says skills and workflowSteps are COMPLEMENTARY not alternatives,
//        and adds a CSR-shape worked example (event-triggered, 7 steps with 2
//        branch points and 3 llm_reason judgment nodes).
//   v6 — Fix the schema/prompt contradiction that made RPM- and CSR-shaped
//        roles drop workflowSteps. The produce_agent tool's workflowSteps field
//        description contained a stale "Omit ONLY for purely conversational
//        roles with no fixed sequence (e.g. Customer Support Rep, debugging-
//        on-demand assistant)" sentence carried over from before v5. The
//        system prompt's v5 worked example uses CSR as the canonical EMIT
//        case, so schema and prompt actively contradicted each other. LLMs
//        weight tool-attached schema descriptions heavily, so even with v5's
//        strengthened prompt the LLM read the schema's CSR-omit example as
//        authoritative and dropped workflowSteps. v6 removes the named
//        example, hardens the schema sentence to mirror the prompt's
//        dominant-trigger language ("if responsibilities text contains a
//        ## Workflows/Steps/Procedure/Instructions section, you MUST populate
//        — no exceptions"), and narrows the omit-criterion to "purely ad-hoc
//        conversational roles with no recurring procedure and no event/cron
//        trigger" so role-name pattern-matching alone never triggers omission.
// v7: adds the COLLABORATION TOOLS prompt section (find_teammates /
//        send_agent_message / read_agent_messages) so distillation wires dynamic
//        peer coordination to the real runtime discovery tool instead of falling
//        back to delegate_to_agent. Prompt-text change → manual bump required.
// v8: adds the WORKSPACE TOOLS section (the runtime's real sandbox
//        tool names, offered on every distillation rather than gated on the
//        pre-call keyword signals) and the reliability-obligations section that
//        states what a goal implies — read the existing keys first, stop on an
//        unreadable read, match and update by key, persist per page. Prompt-text
//        change → manual bump required: the fingerprint covers this constant and
//        not the prompt text, so an unchanged version serves output from the
//        previous prompt to every request whose inputs and catalog are unchanged.
// v9: adds the schema-adoption obligation — a store that already
//        exists owns its own field layout, and the distillation maps onto it
//        rather than specifying one — generalises the record-maintenance
//        obligations across spreadsheets, tables, CRM objects and trackers, and
//        adds the act-exactly-once shape for work that arrives rather than being
//        stored. Prompt-text change → manual bump required.
// v10: a value is written in the format its field already uses —
//        dates, amounts and identifiers converted into the store's form rather
//        than the store reformatted into the source's. Prompt-text change →
//        manual bump required.
// v11: corrects the workflow-step addressing model, which the
//        prompt described three different ways and the runtime implemented as
//        none of them. `condition` gains its first description — predicates are
//        `$.steps.<stepId>.<field>` or `$.input.<field>`, and a bare
//        `output.foo == 1` does not parse and fails the whole run.
//        `toolInputTemplate` is documented as `{{steps.<stepId>.<field>}}`
//        rather than the `{{output.<stepId>.<field>}}` it claimed. The worked
//        exemplar is rewritten: it had mixed two conventions, nesting under both
//        the stepId AND the outputField name, when outputField EXTRACTS — a step
//        with outputField 'thread' stores the thread itself and is read as
//        `steps.s1.subject`, never `output.s1.thread.subject`. Prompt-text
//        change → manual bump required.
// v12: finishes v11, which fixed the guidance paragraph and ONE
//        exemplar and left the schema field description and two other exemplars
//        teaching the broken forms. The model was reading contradictory
//        instructions, and followed the wrong ones: `toolInputTemplate` was
//        described as taking `{{output.<stepId>.<path>}}` and `{{now.iso}}`,
//        NEITHER of which resolves — there is no clock root at all, and
//        `output` is the previous step rather than a step index. An agent
//        following them emits `"BTC price log failed for the {{now.iso}} run"`,
//        which the runtime renders as those literal characters. The two stale
//        exemplars are rewritten onto `{{steps.<stepId>...}}`, and the
//        description now also states WHERE a placeholder goes: inside quotes
//        when it is part of a sentence, bare when it IS the value, so numbers
//        stay numbers. Prompt-text change → manual bump required.
// v13: adds `resultRules` — the distillation now names the tools
//        whose result the agent may only act on in full, and the runtime
//        enforces it. Obligation 3 previously said to read the existing keys
//        first and stopped there, which is a rule the agent has to remember at
//        the one moment it cannot tell it is failing to: a read too large for
//        context comes back as a preview, and a preview of the existing keys
//        makes every unseen record look new. Declaring the read is what turns
//        that from an instruction into a refusal. Prompt-text and tool-schema
//        change → manual bump required.
// v14: a result rule can name `google_sheets_read_values` for an
//        agent whose catalog calls it `google-sheets-d14f7fd5__batch_get_values`
//        — the right operation in the wrong vocabulary, so the rule is dropped
//        and the agent keeps none. The
//        schema now says the name is the long aliased form character for
//        character, and that the workflow step performing the read already
//        carries it verbatim. Prompt-text change → manual bump required.
// v15: a rule about the read that decides what already exists can
//        name the sheet's batch_update — a real catalog tool, the right
//        connector, the wrong operation. It survives validation, so the
//        dangerous call is unprotected while a harmless one carries the
//        policy, which is worse than an invented name because
//        nothing failed. The field is now READ-only in both the schema text and
//        the check, and a write-shaped name is fed back with the reads available
//        on that same connector. Prompt-text change → manual bump required.
// v16: a step may now name `trigger__<op>` — the operation, not the
//        host — when several bound connectors publish the same entity. GitHub
//        and GitLab publish byte-identical polling rows for PullRequest,
//        deliberately, "so one software-delivery-team subscription matches
//        events from both hosts". Triggering was host-agnostic; execution was
//        not, so a step had to hardcode one host and the other host's events
//        ran against it — a GitHub pull request executing GitLab tools, with
//        the approval card truthfully naming GitLab for work living on GitHub.
//        The schema now requires the trigger-bound form in that situation and
//        the runtime resolves it to whichever connector fired. Prompt-text and
//        tool-schema change → manual bump required.
// v17: the workflow contracts the runtime actually implements.
//        Three things the prompt taught that were not true. `{{input.<field>}}`
//        was described as "the workflow input" while an event-triggered run
//        received `{eventSource, eventEntityType, eventData}` — so the CSR
//        exemplar's `{{input.thread_id}}` resolved to nothing, and because an
//        unresolved placeholder rendered the four characters `null`, it reached
//        Gmail as a message id and came back 400. The prompt now names the
//        normalized `input.message.*` envelope field by field. `outputField` on
//        an llm_reason step promised "a dot-path into the LLM's output object"
//        when the runtime returned joined text, so every such step threw on
//        every run; it now states the `record_step_output` call that
//        carries the object. `outputField` on a tool_call invited a wrapper name
//        connectors do not return (`thread` over a Gmail thread that IS the
//        payload), so it now says to omit it unless the response shape is known.
//        Prompt-text change → manual bump required.
// v18: the trigger-bound vocabulary is two ops, not four.
//        GitHub's vendor-MCP surface has no separate tool for a PR diff or its comments — both sit
//        behind `pull_request_read` under a method argument, while the runtime
//        resolver rewrites tool NAMES and not arguments. v16's schema offered
//        pr_get_diff and pr_list_comments, so a distillation could emit steps
//        the runtime was then obliged to refuse. It also named
//        `get_pull_request`, which GitHub does not have at all.
//        Prompt-text change → manual bump required.
// v19: v18 removed pr_get_diff and pr_list_comments from the
//        trigger-bound vocabulary but left the trigger/capability check
//        demanding that a workflow serve every host publishing the entity —
//        with no host-agnostic way left to read a diff. A re-distill could only
//        fail (unknown_tool, then trigger_without_capability) until the caller
//        dropped the steps, leaving the agent with none.
//        The satisfiable answer was always an llm_reason step, which improvises
//        over whichever connector fired; nothing said so. Both the schema text
//        and the retry feedback now name it, and say explicitly that reaching
//        for a host-specific tool to fill the gap just moves the mismatch.
//        Prompt-text change → manual bump required.
// v20: a trigger-bound step no longer authors the arguments that
//        say WHICH record to act on, and all four PR operations are offered
//        again. The step could never write them correctly: it does not know
//        which host will fire, and the identifying arguments are host-shaped
//        (GitHub owner/repo/pullNumber, GitLab project_id/merge_request_iid).
//        Left to try, a distillation emits {"id": "{{input.message.id}}"},
//        which satisfies NEITHER host — every trigger-bound call would
//        fail on arguments however well its NAME resolved. The runtime now
//        builds them from the event record, so the schema asks for semantics
//        only, and pr_get_diff / pr_list_comments are canonical again now that
//        GitHub's single `method`-driven tool can be addressed. Prompt-text
//        change → manual bump required.
// v21: companionCrons gained `workSource`. A cron fire carries no
//        `input`, so a companion running an EVENT-shaped graph (steps reading
//        {{input.message.*}}) had nothing to work on: step 1 failed and the run
//        took whatever onFailure branch existed. Such a sweep can escalate and
//        then mark the mail read — closing tickets it never opened, on every
//        fire, reporting success. The objective prose
//        already said "list X, then for each X run the workflow"; nothing made
//        that machine-readable, and the runtime cannot turn a sentence into a
//        tool call at fire time. Schema change → manual bump required.
// v22: IC_AGENT_PREAMBLE no longer carries the writing-quality
//        rules or the untrusted-data line. Those rules are platform policy, and
//        baking them into generated text made them conditional on the distiller
//        complying, which nothing checked.
//        Interactive chat hid the gap (the Tenant Runtime injected its own copy);
//        autonomous runs had no voice rules at all. They now live in
//        src/shared/agent-voice.ts and are injected by the runtime into both
//        prompts, so what is left here is the two-mode behaviour plus a pointer.
//        The untrusted-data line went too: the runtime's trustPrefix has always
//        stated it at greater length on every autonomous run. Prompt-text
//        change → manual bump required.
// v23: AVAILABLE TOOLS now lists each tool's PARAMETERS —
//        `name(param, required*)` — and the prompt states the convention. The
//        model authors toolInputTemplate for these tools and had been shown
//        only a name and a description, so it guesses the argument names and
//        guesses wrong in the obvious ways: `q` for `query`, `body` for
//        `message_body`, `id` for `thread_id`, and `user_id` omitted entirely
//        because nothing says it is required. Any one of them makes the
//        connector call fail. Schema
//        validation now rejects them, but a correction loop is a poor
//        substitute for telling the model the answer up front — it costs a
//        retry per defect class and can exhaust its budget before converging.
//        Prompt-text change → manual bump required.
// v24: the retry is now a CORRECTION TURN — the model is replayed
//        its own produce_agent call as an assistant tool_use turn and the errors
//        come back as the matching tool_result — instead of a bare list of
//        complaints about an artifact it could not see. v23 named its own
//        limit two lines up ("can exhaust its budget before converging"): a
//        retry can fix the rejected steps and break others, then regress to
//        the first attempt's exact mistakes. With nothing to edit the model
//        re-authors every step each time, so the attempts are independent
//        samples rather than a convergent loop, and the agent can end on
//        `workflowSteps: null`.
//        No prompt text changed, so the fingerprint is unchanged — the bump is
//        for the CACHE: a v23 entry holds output produced under the old
//        non-converging retry, and serving it would silently defeat this fix on
//        exactly the redistills that need it. Behaviour change → manual bump.
// v25: the retry refuses the DEGENERATE REPAIR. Told a tool_call's
//        arguments do not match the schema, a model has a cheap way out: retype
//        the step to llm_reason, which takes no toolName so no argument check
//        applies, or drop it. Both clear the complaint and both validate. A
//        tool_call dispatches ONE named tool with checkable arguments; an
//        llm_reason step DOES receive the full catalog and CAN call connector
//        tools, but is not obliged to — so the trade is a guaranteed, checked
//        dispatch for a discretionary one, made in direct response to the check
//        firing. The correction turn states this and findDegenerateFixes
//        enforces it for the ids the previous rejection named.
// v26: narrows v25 to tools that EXIST. v25 fired on any named id,
//        which fought the prompt: distill-service tells the model to use
//        llm_reason when no catalog tool covers the work, so retyping a
//        tool_call whose tool is not in the catalog is compliance, not
//        evasion, and rejecting it would deadlock the loop against work nothing can do. The guard now skips a
//        step whose abandoned tool is absent from the catalog, and the wording
//        it sends the model no longer claims llm_reason "performs no external
//        action" — it does not, and a correction built on a false premise
//        teaches the wrong rule everywhere else it lands. No prompt text
//        changed, so the fingerprint is unchanged; the bump is for the cache.
//        Behaviour change -> manual bump.
// v27: `onFailure` is documented as the ELSE BRANCH of a
//        `condition`, and a conditional step that omits it is now rejected.
//        The executor sets `currentStepId = step.onFailure || ''` when a
//        predicate does not hold, and an empty string ENDS THE RUN — every
//        later step is skipped and the invocation still reports success. The
//        schema had called onFailure a failure handler and said nothing about
//        conditions, so a step with a predicate and no error had no reason to
//        set one. Example: s4 routes to escalate / ack-only / search-help and
//        s5 guards on search-help with no onFailure, so every escalate and
//        ack-only decision — Critical urgency, billing, refunds, pricing,
//        account security, cancellation — stops the run at s5 with no
//        escalation, no notification, no acknowledgement and no mark-as-read.
//        An escalation branch behind the same shape is dead, and static
//        reachability cannot see it: the branch HAS an inbound edge, just not
//        one for the predicate being false. Prompt-text change
//        (produce_agent schema) -> manual bump required.
// v28: states the CONVERSE of the llm_reason fallback — when a
//        catalog tool DOES cover an action, the step must be a tool_call naming
//        it, and content that needs composing is split (llm_reason returns it
//        via outputField, the next tool_call sends it through
//        `{{steps.<id>.<field>}}`). The prompt only ever taught the fallback
//        direction ("no tool covers this -> llm_reason"), so the model applies
//        it to work that a tool DOES cover. Two redistills of one agent can
//        differ: one graph sends the customer reply through a guaranteed
//        `reply_to_thread` tool_call, the next puts it inside an llm_reason step
//        that does not even name a tool. Both validate. An llm_reason step may
//        call tools but is not obliged to, so the second shape answers the
//        customer only if that step's model decides to — and its arguments are
//        never checked. The reply is the agent's entire job; whether it happens
//        must not vary between redistills. Prompt-text change -> manual bump.
// v29: a companionCron on an EVENT-triggered agent whose graph
//        reads `{{input.*}}` is rejected unless it declares `workSource`. A
//        cron fire carries no inputData — a scheduled run posts an objective,
//        never an event payload — so graph validation rejects every
//        `{{input.message.*}}` reference before step 1 and the routine fails on
//        every fire, by construction, forever. Three consecutive routine
//        failures auto-pause the AGENT and deregister its event trigger, so a
//        broken companion silently switches off the event path that works and
//        the agent shows as paused to an operator who never paused it. An
//        hourly `followup-closeout-sweep` against a graph reading
//        `{{input.message.threadId}}` fails three times, pauses a Customer
//        Support agent whose email trigger is healthy, and the next mail
//        matches no registered agent at all. The runtime
//        already supports the honest form — a `workSource` resolves the items
//        with a listing tool and runs the graph once per item, stamping
//        inputSource so the same references resolve. Prompt-text change
//        (produce_agent schema) -> manual bump required.
// v30: a `tool_call` step may no longer declare `outputField`.
//        The catalog carries input_schema and nothing else — arguments are
//        checkable, responses are not — so the key is one the model has never
//        been shown, and the runtime treats a miss as a HARD step failure:
//        the step fails on a call that SUCCEEDED and the graph takes its
//        onFailure branch. A list_messages call can return 201 with
//        success:true and the step still fail on
//        `outputField "messages" did not resolve in tool result`, because the
//        real envelope is `{"items": [...]}` — neither the model's "messages" nor
//        connector-service's ListResult "records". Omitting it loses nothing:
//        the whole result becomes the step output and a later llm_reason step
//        reads what it needs from the real object, so the narrowing was never
//        load-bearing, only the guess was. The check accepts a path a catalog
//        response schema declares, so it loosens by itself if output schemas
//        ever reach the distiller. Prompt-text change -> manual bump required.
// v31: WORKSPACE TOOLS now lists each sandbox tool's PARAMETERS,
//        and the list itself was wrong. v23 gave connector tools their
//        parameters for exactly this reason — the model authors
//        toolInputTemplate and had been guessing — but sandbox tools carry no
//        `__` prefix, so formatIntegrationsWithTools never grouped them and
//        they render through buildWorkspaceToolsText, which was not updated.
//        They stayed name-and-description only.
//        `shell_exec` takes an ARGS ARRAY and the description here read
//        "Execute shell commands ... any CLI commands", so the model writes
//        `{"command":"echo ..."}`. input.args is undefined, the dispatcher
//        passes undefined through, and the sandbox answers `500 args must be
//        a non-empty array`. The steps fail to onFailure and the run
//        escalates with no answer. The key-invention guard could not catch it:
//        it validates against the connector catalog, which these are not in.
//        The list had also drifted from the runtime registry it is required to
//        mirror: `file_glob` and `file_grep` were named and do not exist (they
//        are `file_search` and `content_search`), while `git_clone` and
//        `git_commit_and_push` exist and were absent — so a graph could name a
//        tool that cannot dispatch, and could not reach git except by
//        improvising through shell_exec. The test asserting "capability truth"
//        was pinning the wrong names, which is how it survived.
//        Descriptions are now taken from the registry rather than paraphrased.
//        Prompt-text change → manual bump required.
// v32: the `ask_user` rule gets a test instead of an adjective.
//        "Information the agent genuinely cannot infer" was doing no work: a
//        distillation could emit an ask_user asking WHICH REPOSITORY to work in,
//        for an agent whose responsibilities enumerate four repositories, name
//        the GitHub organization to use, say "default branch is main unless
//        told otherwise", and name the repo in every request — asking on
//        every run for something it had been handed. The same graph could DROP
//        the one checkpoint the text did ask for — "if a task requires
//        destructive operations, confirm first" — by recording `destructive`
//        and `confirmed` as fields and gating nothing on them.
//        So the rule now asks three concrete questions (is it enumerated, is it
//        in the request, is there a default) and says a "yes" to any of them
//        forbids the step, carries the failure above as a worked example, and
//        requires a `condition` on any ask_user reached only in a specific
//        case — the precondition in `description` gates nothing, because the
//        runtime reads `condition` and never reads `description`.
//        Prompt-text change → manual bump required.
// v33: EVENT TOPICS lists only topics something can DELIVER, and
//        rule 2 stops apologising for their absence.
//        The section was gated on `listImplemented`, which means list() can
//        enumerate records for backfill — not that an event ever reaches an
//        agent. With github's flag true, `pr.opened` appeared here; a
//        redistill copies it out, per rule 1, and the runtime pauses the
//        five-minute cron that was doing the work. Nothing delivers a polled
//        github event: connector-service publishes connector-events-{env} in the
//        CONTROL project, tenant-runtime subscribes to a same-named topic in the
//        TENANT project. An agent that ran every five minutes stops running.
//        Now gated on `eventTrigger`, whose slug connector-service arms and
//        tenant-runtime dispatches from — a receiver at the far end. That also
//        REVEALS event-only connectors (google_docs, todoist, trello, typeform:
//        listImplemented false, eventTrigger set) whose topics were hidden.
//        Rule 2 said "do NOT assume Gmail/Outlook/GitHub are cron-only" — advice
//        that pushed the model past a correct absence. It now reads the section
//        as authoritative in both directions and says plainly that a cron which
//        runs beats an event trigger that never fires.
//        Prompt-text change → manual bump required.
// v34: the ask_user test named the RESPONSIBILITIES block alone.
//        The model is handed three authored blocks — ROLE, RESPONSIBILITIES,
//        ADDITIONAL_CONTEXT — plus any attachment, and ADDITIONAL_CONTEXT is
//        where a person most often puts precisely the operational detail the
//        test is about: which repositories, which environments, which channels.
//        A value supplied there and absent from the responsibilities passed the
//        test as written, so the step could still be emitted and the agent
//        would still ask for something it had been given, one field over.
//        Prompt-text change → manual bump required.
// v35: a step may not state that a LATER step's action has
//        happened. A notification can only report what steps BEFORE it did.
//        A Slack escalation at s7 reading "A brief acknowledgement has been
//        sent to the customer", when the acknowledgement is s9, two steps
//        later, is false when it is written and stays false if s9 then fails
//        on a vendor rejection and sends nothing at all. A person reading that
//        escalation reasonably concludes the customer has been answered. That
//        is INV-PB-004's fabricated success written into the workflow graph
//        rather than returned by a tool, and no runtime check can catch it: the
//        Slack post genuinely succeeds, it is its CONTENT that lies. Stated on toolInputTemplate,
//        where the sentence is composed, with both ways out — order the action
//        before the notification, or write the notification in the future
//        tense. Prompt-text change (produce_agent schema) -> manual bump.
// v36: GATHERING is carved out of the tool_call rule. Rule 3 says
//        an action a catalog tool covers MUST be a tool_call, because an
//        llm_reason step "may call tools but is not obliged to". That is right
//        for actions and wrong for retrieval: a tool_call issues exactly one
//        query and fetches exactly one result, while how many queries a search
//        needs and how many documents bear on the answer are not knowable when
//        the graph is written. The asker's words are often not the corpus's
//        words, and one question can span two procedures, so a search tool_call
//        feeding a single-slug fetch tool_call hard-codes "one result is
//        enough" into a graph that cannot know it. The gather is now one
//        llm_reason step holding the search and the reads together, declaring
//        an outputField. The "maybe, not a step" objection does not carry over
//        because the guarantee differs: for an action it is that the dispatch
//        happened, for a gather it is that a value was produced, and a declared
//        outputField with nothing recorded fails the step.
//        Prompt-text change (produce_agent schema) -> manual bump.
// v37: an agent watching a queue gets a way to say "not my work".
//        A trigger on a mailbox or ticket queue delivers everything that lands
//        there, not only the records the role is about — delivery-failure
//        notices, auto-replies, calendar invitations, vendor newsletters. With
//        only "handle it" and "escalate" as exits, each of those becomes an
//        escalation and a person is asked to look at a bounce message. That is
//        worse than doing nothing: it trains people to dismiss the queue, and
//        real escalations arrive in the same pile. The first judgement after
//        fetching a record is now whether it is the kind of work the role
//        exists for, decided before triage and before any search, with a quiet
//        close-out path that marks it handled and ends the run. Judged on the
//        SENDER and the purpose rather than the topic, since a customer asking
//        about billing is in scope and a vendor's invoice reminder is not.
//        Also: the four synthetic catalog entries (delegate_to_agent,
//        find_teammates, send_agent_message, read_agent_messages) now carry
//        categories. They were the only entries with no classification at all,
//        and a tool the catalog cannot classify is one the HITL gate cannot
//        classify either — it fails closed into an approval no oversight
//        control explains.
//        Prompt-text change (produce_agent schema) -> manual bump.
// v49: the rest of the standard tools become reachable. v48 put
//   tabular_extract and have_i_acted_on in the catalog and left 29 others out,
//   so the same failure stayed live for them: a step naming one fails the
//   unknown_tool guard and the retry loop rewrites it as llm_reason, silently.
//   Seven more join them, chosen by what the catalog already promises:
//   schedule_followup and cancel_followup (8 templates say "send one reminder
//   after 2 business days" or "check every 24 hours until resolved" — a
//   deferred promise with no way to defer), audit_log (8 say to record an
//   action for a person to audit), corpus_search (the knowledge repository,
//   otherwise improvised through a connector), memory_save and memory_retrieve
//   (the store case (b3) falls back to when no data table is bound), and
//   data_landscape (what the team can actually reach, which the initiative rule
//   assumes).
//   Deliberately still out: notifications_send, because delivery can be
//   disabled and an emitted step would then do nothing; and the browser family, which is
//   gated on capability tier, so a connector-only agent would emit steps it
//   cannot dispatch.
// v48: the two reliability primitives enter the catalog, which is
//   what v43, v46 and v47 were each really missing. The catalog handed to
//   validateWorkflowSteps is built from the tenant's CONNECTOR manifests plus
//   four synthesised builtins and the platform web tools. `tabular_extract` and
//   `have_i_acted_on` are runtime STANDARD tools and were in none of those, so
//   every step naming one failed the `unknown_tool` guard and the retry loop
//   rewrote it as llm_reason exactly as the correction instructed. Rewording
//   an instruction cannot help while the validator deletes the answer to it,
//   and the evidence reads as a model ignoring prose.
//   Only connector steps and synthesised builtins (send_agent_message among
//   them) survive that check. Text-matching stored workflow_steps for a tool
//   name misleads: the name can appear inside an llm_reason step's prose
//   without ever being a tool_call.
//   Both are standard-family, so they are already in `availableToolNames` and
//   `resolveToolDispatch` answers 'standard': they validate and dispatch with no
//   runtime change, exactly as v45's web tools did.
//   Catalog-only change; the prompt text is unchanged and the fingerprint holds.
// v47: the column contract moves into the produce_agent schema.
//   v46 put it in the user message, which is not enough: a hire that loads its
//   template is handed its columns as prose and is still free to emit no
//   tabular_extract step. v6 recorded the same asymmetry — a
//   tool-attached description outweighs prose — so the requirement now lives on
//   the workflowSteps field itself, and says explicitly that the
//   "platform extracts all N columns" sentence in the responsibilities IS this
//   step rather than something happening on its own.
// v46: a deliverable is made by one step and placed by another,
//   and which pair is right depends on what is bound. 25 sentences across the
//   catalog promise a produced document and a destination for it ("write the
//   grid beside the source", "deliver it as a Word document", "return the
//   download link") with no step behind either half. Case (b4) states the three
//   cases: a documents tool creates the document natively, with nothing to
//   generate and upload; cloud storage takes the generate-then-place pair; and
//   with neither bound the file still registers with the platform, so the work
//   is returned as a link rather than skipped. It also forbids the
//   unconditional "beside the source" promise, which is false the moment the
//   source is a page in a documents tool.
// v45: the agent reads the web with platform tools, not shell_exec.
//   The catalog only ever offered sandbox + bound connectors, and the workspace
//   rules told the model that "fetching a URL is workspace work — use
//   shell_exec". So every research-shaped agent curled pages in the sandbox:
//   unsourced, slow, and prone to a generic hallucinated list with no links.
//   The platform's native web/research tools (web_research, web_fetch_advanced,
//   web_deep_research, web_people_search, web_finance_search) are exposed to
//   every agent with no connector binding — they are now in the catalog and in
//   a PLATFORM RESEARCH TOOLS section, and the workspace rule is reweighted:
//   reading a page or researching is those tools; shell_exec is for local
//   computation or a programmatic API nothing else covers. BYOK web tools
//   (web_extract/web_diff/web_task/sessions) stay out — they need a connected
//   vendor, so surfacing them universally would fail UNRESOLVABLE.
// v44: a comparison is two steps, not an adjective. 19 templates
//   promise "week over week", "day over day" or "since the last run", which all
//   need a record a PREVIOUS run wrote; nothing said to write one, so a second
//   run knew nothing about its first and the delta was either the current
//   number restated or invented. Case (b3) requires a read step before the
//   analysis and a write step after it, against the store the responsibilities
//   already name (most of these roles say "the running history sheet"), with
//   the comparison declared unavailable rather than fabricated when no store is
//   bound, and the record written even on an uneventful run so the series stays
//   unbroken.
// v43: a promised mechanism has to compile into a step. Two
//   sentences the catalog repeats had no machine-readable half, so the agent
//   improvised one differently on every run:
//   - "the platform extracts all N columns in parallel" (11 templates). The
//     runtime tool tabular_extract was built for exactly this and takes the
//     template's own extractionSchema shape; the columns never reached it,
//     because nothing read the field. They now enter the prompt as data with an
//     instruction to compile them into a tabular_extract step, passed verbatim.
//   - "do not act on the same thing twice" (18 templates). have_i_acted_on has
//     existed all along, backed by the action ledger with four verdicts. The
//     idempotency rule told the model to DESIGN a store instead of naming the
//     one it has, so agents invented labels and notes. Rule 1 of case (b2) now
//     points at the tool and states its limits; rule 2 asks for a step rather
//     than a sentence.
//   Neither names a tool in customer-facing copy: the primitive belongs in the
//   compiled step, never in systemPrompt or userInstructions.
// v42: a review is ONE artifact, not N comments. Adds the
//   three-step review flow — trigger__pr_review_begin / _comment / _publish —
//   and forbids a loop of trigger__pr_add_comment for findings.
//   pr_add_comment posts to the pull request's CONVERSATION and takes no path
//   or line: the GitHub surface gives add_issue_comment
//   (issue_number, owner, repo, body) and nothing else. Findings sent through
//   it arrive stripped of the file and line they are about, as N loose comments
//   where the role's own rule asks for one review.
//   The bracket ops are the BATCH, not an approval gate. GitHub assembles a
//   review as a draft (pull_request_review_write method=create, then
//   add_comment_to_pending_review, then method=submit_pending); GitLab posts
//   notes directly, so the runtime SKIPS both brackets there and one graph runs
//   on either host.
//   See docs/design/defect-3-reactive-pr-events.md.
// v41: declare every event the role handles, not just the first.
//   "On PR opened, updated, ready-for-review, or reopened" is four topics, and
//   an agent whose responsibilities name push and reopen handling while it
//   declares only pr.opened never sees the rest. `eventTopics` carries the full set. It is a
//   DECLARATION: no subscription, no schedule, no extra dispatch. What it
//   governs is the per-binding filter derived from it, so a topic left out is
//   an event the agent never sees.
//   Deliberately NOT routed through reactiveSubscriptions or companionCrons.
//   Those bindings' connectorRef validation fails and falls back to companion
//   crons, and a companion cron carries no event payload — three failed fires
//   auto-pause the agent and deregister the event trigger. Declaring more would
//   have reinstated the polling this work removed.
//   See docs/design/defect-3-reactive-pr-events.md 5b.
// v40: an outward act happens ONCE per run. Rule 3 already said an
//   action must be guaranteed to happen; nothing said it must not happen twice,
//   and two steps calling the same posting tool with no condition between them
//   post twice on every run regardless of what the responsibilities ask for.
//   Rule 6 asks for the arithmetic up front — walk `onSuccess` from each
//   outward step and see whether it reaches the same tool again with nothing
//   conditional in between — and `findRepeatedOutwardActions` refuses the graph
//   when it does, the same way announce-gating refuses an ungated announcement
//   rather than merely preferring a gated one.
//   See docs/design/defect-3-reactive-pr-events.md §6.
// v39: a step that ends the workflow must declare `expectedOutput`
//   — what it produces for the person who asked, in their terms. An agent can
//   review a pull request, post a substantive review, and reply nothing; the
//   person sees their own message and silence while every layer below the
//   graph works. Nothing said reporting back was part of the job, so nothing
//   was missing when it did not happen. Modelled on CrewAI's per-task
//   `expected_output`: declare the answer rather than hope the model volunteers
//   it. And where a person is WAITING (a manual trigger), a terminal tool_call
//   is not a report — its output is the tool's response — so the graph needs a
//   final llm_reason step that says what happened. Not required on cron/event
//   graphs, which have no reader and would pay a model call per fire for a
//   summary nobody opens. See docs/design/the-reply-is-part-of-the-work.md.
// v38: a companion routine may narrow the agent's business, not
//        widen it. A connector binding's filter is the user's statement of
//        which records the agent is for; a routine declared its own selection
//        in workSource.toolArgs and nothing related the two, so one
//        distillation defined the business twice and the routine's copy was
//        the wider one. A support agent bound to `to:support@...` whose
//        routine sweeps `is:unread in:inbox` opens delivery-failure notices
//        and vendor mail addressed to someone else.
//        SCOPE clauses (to:, deliveredto:) must carry through unchanged; STATE
//        is the routine's own, since an unread sweep wants is:unread and a
//        follow-up sweep deliberately wants threads already read — which is
//        why ANDing the whole binding onto every routine would be wrong.
//        Enforced by string containment of the binding's own scope clauses, so
//        the check cannot misread a query it does not fully parse.
//        Prompt-text change (produce_agent schema) -> manual bump.
// v51: give rule 4a the predicate instead of the intent. It said
//   to branch on the event's `action` and left the path to be guessed. The
//   runtime evaluates a step condition against `{ input: inputData, steps }`
//   and the event record IS `inputData.eventData`, so
//   `$.input.eventData.action == 'synchronize'` resolves — checked against
//   condition.ts and get-by-path.ts rather than assumed. A guessed path either
//   fails to parse and kills the run, or parses and reads undefined, which
//   sends every event down the full-diff edge and looks like the feature
//   working. Also spells out that the condition needs an `onFailure` edge,
//   since a condition without one ends the run on every non-synchronize event.
//   Prompt-text change (review-cycle rule 4a) -> manual bump.
// v50: a re-review reads what CHANGED and what it already SAID.
//   `pr_get_diff` returns the whole pull request every time, so every push made
//   the reviewer re-read everything and re-derive the same findings in
//   different words. A busy pull request collects many inline comments —
//   several on ONE line, and none byte-identical, which is why comparing the
//   text was never the answer.
//   Three ops join the trigger-bound vocabulary and rule 4 of the review-cycle
//   contract tells the graph how to use them: branch the diff step on the
//   event's `action`, so `synchronize` reads `trigger__pr_get_diff_since` and
//   the opened/reopened/ready_for_review actions still read the whole PR; call
//   `trigger__pr_list_review_threads` on every branch and do not re-raise a
//   finding an unresolved thread already makes.
//   `pr_get_diff_since` resolves to GitHub's `get_commit` with
//   `detail: full_patch`, NOT the compare endpoint — that endpoint is not among
//   the tools the vendor MCP server publishes, and the commits endpoint
//   answers 422 for a `base...head` range. One commit is the narrowest scope an
//   agent can actually reach, so `pr_list_commits` goes with it: a push of
//   several commits is wider than the one that gets read, and the commit list
//   is what makes that visible instead of a silently partial review.
//   State is carried as GitHub's own `is_resolved` / `is_outdated` rather than
//   as remembered text, so the agent cannot hold a private view that disagrees
//   with the pull request.
//   Prompt-text change (trigger-bound op list + review-cycle rule 4) -> manual bump.
//   See docs/design/incremental-review-implementation.md.
// v51: a column contract can now describe MANY rows per document.
//        `tabular_extract` fans out per column and assembles one row, which is
//        right for a review memo answering each topic once and wrong for a
//        checklist with one line per condition precedent — and wrong
//        invisibly, since a table collapsed to a single row is still a
//        well-formed table. `tabular_enumerate` inverts the fan-out (one read
//        returning an array) and a template's `extractionRowDefinition` picks
//        between them, because the two take identical columns and only the
//        meaning of a ROW differs. Prompt-text change (the column-contract
//        block and the workflowSteps schema) -> manual bump.
// v52: the incremental-review rules become their own section, so
//   they reach the agent they were written for. They sat inside the
//   review-cycle contract, which requires a software-delivery `templateId` —
//   and a templateId is only set when the agent was seeded from a team preset.
//   A reviewer agent not seeded from a preset, bound to the GitHub App and
//   reviewing pull requests on an event trigger, has `template_id = NULL`: the
//   prompt carried the rules, every test passed, and the agent they existed for
//   could not see them. Now gated on the github BINDING alone, which is the real
//   precondition: the ops resolve against a connector publishing PullRequest
//   events, so an agent without one could not follow them anyway. The section
//   names its own precondition in prose, so a github-bound agent that does not
//   review pull requests reads a sentence and moves on. Rules 1-3 keep their
//   template gate — that audience is a deliberate choice, and widening it is a
//   different decision from fixing this.
//   Also gives rule 1 the predicate instead of the intent. It said
//   to branch on the event's `action` and left the path to be guessed. The
//   runtime evaluates a step condition against `{ input: inputData, steps }`
//   and the event record IS `inputData.eventData`, so
//   `$.input.eventData.action == 'synchronize'` resolves — checked against
//   tenant-runtime's condition.ts and get-by-path.ts rather than assumed. A
//   guessed path either fails to parse and kills the run, or parses and reads
//   undefined, which sends every event down the full-diff edge and looks like
//   the feature working. Also spells out that the condition needs an
//   `onFailure` edge, since a condition without one ends the run on every
//   non-synchronize event.
//   Prompt-text change (review-cycle rule 4a) -> manual bump.
// v53: a prose sentence saying to open a chat thread now compiles
//        into the step that does it. v52 put `open_chat_thread` in the catalog,
//        which made the step POSSIBLE and not required: an agent whose text
//        reads "open a chat thread saying it is ready" can still emit no such
//        step. The same lesson tabular_extract taught
//        across v43, v46 and v47 — catalog presence is necessary and never
//        sufficient, and the obligation has to be stated as a case.
//        Prompt-text change (reliability obligations, case b5) -> manual bump.
// v55: stop emitting a cadence the scheduler refuses. The floor in
//   tenant-runtime cloud-scheduler.ts is 300s and it REFUSES rather than clamps,
//   so `*/1 * * * *` produced no job at all: the config read as every-minute
//   while the agent never fired. The prompt had been instructing exactly that,
//   and explicitly forbidding `*/5`. Now `*/5` is the floor-respecting default,
//   and a request faster than the floor is recorded in `reasoning` as an honest
//   ask for `companion_cron_high_frequency_enabled` rather than silently
//   producing a dead schedule.
// v54: a message can now say a clause only sometimes. The template
//        language had no optional marker, so a responsibility reading "notify the
//        channel, and if escalated name the surface" could only be flattened into
//        an unconditional {{steps.sN.escalation_reason}}. On every run that had
//        nothing to escalate that step produced null, the null guard failed the
//        step correctly, and the whole notification died — so the ORDINARY case
//        was the one nobody heard about, which is the exact inverse of the
//        responsibility. A trailing `?` renders absent as nothing. The prompt now
//        says to mark such a placeholder rather than drop the condition, and to
//        have the producing step return the whole clause rather than a fragment.
//        Paired with tenant-runtime 187c887, which is what understands the marker.
//        Prompt-text change (toolInputTemplate schema description) -> manual bump.
// v56: a cadence under an hour no longer beats an available event
//        topic. Rule 1 already said event wins and analyzer Rule 6 makes it
//        deterministic, but Rule 6 stood down on ANY explicit cadence, so
//        responsibilities reading "check for new pull requests every 5 minutes"
//        kept distilling onto cron even with eight github topics listed. The
//        escape now applies only to cadences of an hour or more, and to batched
//        digests; a sub-hourly cadence survives as a companion catch-up sweep.
//        Prompt-text change (trigger decision tree) -> manual bump.
// v57: the analyzer joins the version's fingerprint. Its rules
//        reject a distillation and feed the model retry text, so they decide the
//        output as much as the prompt does — but they are not in the cache key,
//        so a Rule 6 fix can be answered from cache with the pre-fix
//        trigger. The ratchet now hashes trigger-config-analyzer.ts, which
//        forces a bump on any rule edit. Bumped here to clear entries built
//        while Rule 6 could not see check-for-new roles.
// v58: the OBLIGATION FENCES join the fingerprint, one file over
//        from where v57 put the analyzer and for the identical reason. The five
//        findMissing* validators reject a distillation and feed the model retry
//        text, so they decide the output as much as the prompt does, and none of
//        them was hashed. Correct the artifact-write fence to stop counting an
//        uncategorised READ as a write, and the next redistill is served the
//        same read-only graph from cache — an agent that reads its documents
//        and never writes the deliverable it exists to produce. Bumped here
//        to clear entries built while a read satisfied the fence that demands
//        a write.
// v59: a skill description now has to say what it is NOT for. It
//        was one clause — "Use when <trigger>" — which is a retrieval key with
//        no boundary, so every skill on an agent competed for the same top-K
//        and a request that belonged to one pulled in three; two skills that
//        differ only in wording are indistinguishable. The schema now
//        requires a second clause naming the neighbouring request class and the
//        sibling that owns it, and both authoring exemplars carry one so the
//        shape the model copies has it. Schema + exemplar change -> manual bump;
//        bumped here to clear entries built while a trigger alone was a
//        complete key.
// v60: a template's authored flows and tool notes now reach the
//        output as skills verbatim, with the flow's own id as the skill id, so
//        an authored decomposition stops being re-derived — and re-identified —
//        on every hire. That is what orphans skill metrics:
//        agent_skill_metrics rows end up pointing at ids no live skill carries,
//        so skill-level learning cannot accumulate. Output shape change -> manual
//        bump, to clear entries built while flows were prose the model read.
// v61: the provenance obligation gained its graph fence. A
//        template setting writesRequireProvenance promises the agent acts only
//        on records the run has read, and the runtime's gate can only HOLD a
//        call — so a graph that writes before it reads turns every write into a
//        hold, which is a broken agent reported as a working one. Fence change
//        -> manual bump: v60 entries were accepted without it.
// v62: the layer table, and its first row made real. produce_agent
//        gained `toolDescriptionOverrides` — per-tool rules the runtime appends to
//        that tool's description, so a rule governing one call is read when that
//        call is written rather than on every turn. produce_agent also gained
//        `decisionRecord`, so a distillation records what it DECIDED — the
//        cadence it wanted and could not have, the assumptions it made — and the
//        next one merges against that instead of re-deciding from scratch.
//        Schema + prompt change. One rule, one criterion — HOW OFTEN a rule is
//        needed decides which layer holds it: one call's arguments go in that tool's
//        description, most turns in the system prompt, a minority multi-step procedure
//        in a skill. Plus the corollary that a rule the core journey needs on most
//        conversations moves a layer DOWN. Written to stop the same policy appearing
//        in two layers with different thresholds, which is not redundancy but a
//        contradiction the model resolves differently on different turns. Prompt text
//        change -> manual bump.
// v63: the guard's verdicts, by their real names. The prompt taught
//        `not_acted`, which `have_i_acted_on` stopped returning when it was renamed
//        to `no_record` — the old name claimed something about the world the ledger
//        cannot know, since it records DISPATCH and "nothing recorded" is not "did
//        not happen". A graph authored against a verdict the tool never emits carries
//        a branch that can never be taken, and the model cannot discover that: it is
//        told the contract, not reading it. The prompt now also teaches `versionBasis`,
//        so a graph knows when `acted` means only that a call went out — which on every
//        connector but GitHub is all it can mean, the ledger deriving a revision for
//        none of the others. Plus a new obligation: a tool_call that hands on to a next
//        step must declare an `onFailure`, or that successor decides from a value the
//        failed step never produced. Prompt text change -> manual bump.
// v64: the trigger tool teaches GUIDANCE SUPERSESSION: a later
//        guidance line that states it replaces or stops an earlier cadence
//        wins, and the trigger set derives from the final state. Without this,
//        a stop line appended by the change/stop rail (migration 429) coexists
//        with the cadence it stopped and the distiller re-emits the dead cron.
// v65: the PRIOR ART section joins the prompt — fenced building
//        blocks from capability discovery with the judge's reasons and any
//        absorbed blueprint procedure. The section CONTENT keys the cache
//        through priorArtHash in the fingerprint (research lands and changes
//        the section while every other input is byte-identical); this bump
//        covers the advisory header text around it.
// v66: stops that REMOVE the guidance line get a STOPPED ROUTINES
//        prompt section and analyzer rule stopped_cadence_present. Supersession
//        (v64) only covers a stop line that is PRESENT; when the line is
//        removed in place, the model's only trace of the routine is the
//        previous trigger set and the prior decision record, and it kept the
//        companion "for label stability". The section overrides both and the
//        analyzer rejects a trigger set still carrying the stopped cadence.
// v67: first-class capability workflow steps. The produce_agent
//        schema gains a `capability` step variant (a vendor-agnostic
//        capabilityNeed the runtime resolves at execution), the step-type list
//        names it, and PRIOR_ART_HEADER steers discovered public-data / action
//        capabilities to a capability step describing the NEED rather than
//        naming a provider. Bumped so no agent is served the pre-capability
//        prompt from cache.
// v68: the rules the fences enforce are stated before the graph
//        is authored. The onFailure description requires it on every
//        non-terminal tool_call; the toolInputTemplate description states the
//        person-read prose rule (one whole placeholder or literal text, no em
//        dash) instead of teaching the splice it rejects; the system prompt
//        carries the scripted-copy voice rule; and the user message opens with
//        the template's declared obligations. Bumped so a cached artifact
//        authored without them is not served as if it had been.
// v69: `web_search`, the basic ranked search, joins the platform
//        research tools the prompt names, ahead of `web_research`, whose
//        description now says what it is (synthesis) and is not (a plain
//        search). Bumped so every agent re-distills knowing the cheap search
//        exists rather than reaching for the research tool to find a page.
// v70: records that live on a named platform — posts, profiles,
//        listings — are a capability need, and the step is type=capability.
//        Stated in the PRIOR ART header, the step type's description and the
//        capability step's own. Bumped so a cached graph that reached for a
//        web search to pull a platform's records is authored again.
// v71: no step has a clock — a time argument never comes from a
//        reasoning step's output; a post or send that happens now names the
//        tool that acts now. Bumped so a cached graph that scheduled a post at
//        a time a model made up is authored again.
// v72: a report names its sources — a digest or summary step
//        says which step's output each section reports and reports an empty
//        pull as empty. Bumped so a cached graph whose digest step could be
//        filled from a store's old rows is authored again.
// v73: a loop over independent items can be told to finish past
//        a failed item (`continueOnItemFailure`) and report which failed,
//        instead of the first dead website ending the whole check. Bumped so
//        a cached graph whose loops abort on the first item is authored again.
// v74: the artifacts call the unit "this agent", never "agent"
//        and never "team" on its own, and the preamble every persona ends with
//        says "This agent operates in two modes". Bumped so a cached persona
//        that introduces itself as an agent is authored again.
// v75: a loop names its collection as steps.<stepId>.<field>; the
//        schema previously offered output.<stepId>.<field>, which resolves to
//        nothing because `output` is the previous step output rather than a map
//        of steps. Bumped so a cached graph whose loop could never iterate is
//        authored again.
// v76: a loop runs an llm_reason step too, and per-subject work
//        SHOULD be looped rather than gathered into one step. A step gets a few
//        minutes; a sweep reading several competitors across several surfaces
//        each in ONE step can be cut off before it finishes, register no
//        output, and strand every step after it. Bumped so a cached graph carrying one oversized research step is
//        authored again as a loop.
// v77: the destination a person PICKED reaches the prompt, and a
//        file destination is checked on the graph. Both distill routers stripped
//        `kind`, so the distiller never saw whether a folder or a document was
//        chosen and wrote every graph as though it were a folder: documents
//        resolved by title string, a new one created whenever the search missed,
//        so a Google Doc a person picked could go unwritten. Bumped so a cached graph that
//        cannot address the chosen document is authored again.
// v78: the commit-attribution line in the review-cycle contract
// named a hardcoded email domain, so an agent in ANY deployment signed its
// commits with an address belonging to somebody else, in the customer's own git
// history. Bumped so a cached graph re-authors with the local trailer.
// v79: the product noun changed. Every artifact the distiller
//        writes now calls the unit an "agent" rather than an "AI team", and one
//        from outside the workspace an "external agent"; "the AI workforce" and
//        "the human workforce" are kept. Bumped because the cache fingerprint
//        covers (promptVersion, inputs, catalogHash) and NOT the prompt text, so
//        without it every agent whose inputs are unchanged keeps the old
//        vocabulary indefinitely and the rename reaches nobody.
// v80: several worked examples and rationale passages restated as general
//        guidance. No rule changed. Bumped so the prompt text and its version
//        stay in step.
const DISTILL_PROMPT_VERSION = 'v80';

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/** SHA-256 of the tool catalog content. Included in the fingerprint so that
 *  connector schema updates automatically invalidate cached distillations even
 *  when the agent's integrations list is unchanged. */
export function computeCatalogHash(catalogMap: Map<string, unknown>): string {
  const sorted = JSON.stringify(
    [...catalogMap.entries()].sort(([a], [b]) => a.localeCompare(b)),
  );
  return createHash('sha256').update(sorted).digest('hex');
}

/** Stable fingerprint of a distillation request.
 *
 *  Inputs are normalized before hashing:
 *  - integrations sorted by id (eliminates ordering differences)
 *  - strings trimmed
 *  - catalog content hash included (invalidates on connector schema changes)
 */
/** The template-declared obligations that gate distillation validation.
 *
 *  Anything here changes the OUTPUT a template demands without changing the
 *  prompt, so it belongs in the key. Anything that only shapes prompt text does
 *  not: the prose is already hashed above.
 *
 *  A template that has been withdrawn hashes as null rather than throwing. The
 *  agent still has its own stored prose, which is what the rest of the key is
 *  built from. */
function templateContract(templateId: string | undefined): unknown {
  if (!templateId) return null;
  try {
     
    const { getTemplate, initTemplateLoader } =
      require('../agent-templates/loader') as typeof import('../agent-templates/loader');
    // Idempotent, and load-bearing: an uninitialised loader answers `undefined`
    // for every id, which would hash as "no template" and hand back the very
    // stale entry this field exists to miss. A wrong answer here is silent.
    initTemplateLoader();
    const tmpl = getTemplate(templateId);
    if (!tmpl) return null;
    return {
      id: tmpl.id,
      requiresIdempotencyCheck: tmpl.requiresIdempotencyCheck === true,
      comparesWithLastRun: tmpl.comparesWithLastRun === true,
      producesDocument: tmpl.producesDocument === true,
      extractionRowDefinition: tmpl.extractionRowDefinition ?? null,
      extractionColumns: (tmpl.extractionSchema ?? []).map((c) => c.name),
      // Authored flows and tool notes reach the OUTPUT verbatim, so two
      // templates differing only in them must not share a cache entry. Hashed
      // by content rather than by id: editing a flow's body without renaming it
      // is the ordinary way a catalog change happens, and an id-only hash would
      // serve the pre-edit skill forever.
      flows: (tmpl.flows ?? []).map((f) => `${f.id}:${f.useWhen}:${f.notNeededFor}:${f.body}`),
      toolNotes: Object.entries(tmpl.toolNotes ?? {}).sort().map(([k, v]) => `${k}:${v}`),
      domainAliases: Object.entries(tmpl.domainAliases ?? {}).sort().map(([k, v]) => `${k}:${v}`),
    };
  } catch {
    return null;
  }
}

/** Stable hash of a rendered prior-art section, '' for an absent section. */
export function computePriorArtHash(section: string): string {
  if (!section) return '';
  return createHash('sha256').update(section).digest('hex');
}

// priorArtHash is REQUIRED, '' for an absent section: a caller that could
// omit it would silently key the cache without the prior-art dimension, which
// is the exact silent-staleness class this parameter exists to prevent.
export function computeFingerprint(input: DistillInput, catalogHash: string, priorArtHash: string): string {
  const normalized = JSON.stringify({
    promptVersion: DISTILL_PROMPT_VERSION,
    // The prior decision record is an INPUT to this distillation — it is
    // rendered into the user message as a section the model must honour — so
    // two runs that differ only in it must not share an entry. Without this a
    // redistill after a decision changed would serve the pre-change answer,
    // which is the one case the record exists to prevent.
    priorDecisionRecord: JSON.stringify(input.priorDecisionRecord ?? {}),
    tenantId: input.tenantId?.trim() ?? '',
    role: (input.role ?? '').trim(),
    responsibilities: (input.responsibilities ?? '').trim(),
    integrations: [...(input.integrations ?? [])]
      .sort((a, b) => (a.id ?? '').localeCompare(b.id ?? ''))
      .map(i => ({ id: i.id, name: i.name, type: i.type, selectedObjects: i.selectedObjects })),
    additionalContext: (input.additionalContext ?? '').trim(),
    // Expectations are constraints on the OUTPUT: a run allowed to produce
    // anything and a run required to contain a specific cron must not share an
    // entry, or the verification is silently skipped on every cache hit.
    expectedCadences: [...(input.expectedCadences ?? [])]
      .map((e) => e.cronExpr.trim())
      .sort(),
    // Stopped routines are BOTH prompt text (the STOPPED ROUTINES section
    // renders the prose) and an output constraint, so the prose is in the key
    // alongside the cron — two runs differing only in what was stopped must
    // not share an entry.
    stoppedCadences: [...(input.stoppedCadences ?? [])]
      .map((s) => `${s.prose.trim()}|${s.cronExpr?.trim() ?? ''}`)
      .sort(),
    // Declared-input answers are prompt text, so they are cache key text.
    // tenantId already separates workspaces, but one workspace can hire the
    // same template twice with different answers — an agency, a holding
    // company, or someone fixing a typo and hiring again. Without this the
    // second hire silently receives the first one's agent, and every output
    // still looks correct. Sorted so key order never changes the hash.
    templateInputs: Object.fromEntries(
      Object.entries(input.templateInputs ?? {})
        .map(([k, v]) => [k, (v ?? '').trim()])
        .filter(([, v]) => v.length > 0)
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
    // Picks are prompt text for the same reason: they are substituted into the
    // prose. Two teams hired from one template into different channels differ
    // only here, and without it the second silently receives the first one's
    // instructions, posting to a channel its owner never chose.
    //
    // `kind` is in the key because it CHANGES THE PROMPT, not just the sentence
    // the pick lands in: a file destination and a folder destination are given
    // opposite instructions about where the work goes (destination-rule.ts, which
    // both the prompt and the stored prose read). Two picks with one id and one
    // title and different kinds would otherwise share an entry, and the second
    // hire would be served the first one's rule — a person who picked a document
    // handed a graph told to create documents in a folder.
    //
    // A pick is still dropped on the same test as before, TITLE AND ID: a pick
    // that names nothing produces no rule, and letting its `kind` move the key
    // would split two identical hires apart for a value neither of them uses.
    templatePicks: Object.fromEntries(
      Object.entries(input.templatePicks ?? {})
        .map(([k, v]) => [k, {
          named: `${(v?.title ?? '').trim()}|${(v?.id ?? '').trim()}`,
          kind: v?.kind ?? '',
        }] as const)
        .filter(([, v]) => v.named !== '|')
        .map(([k, v]) => [k, `${v.named}|${v.kind}`])
        .sort(([a], [b]) => String(a).localeCompare(String(b))),
    ),
    // Attachments shape the prompt like additionalContext does, so they must
    // shape the fingerprint too. addedAt is excluded (re-importing the same
    // file should still hit); source is included (it appears in the fenced
    // prompt text). Connector entries hash by reference — a remote edit
    // within the cache TTL is an accepted staleness window.
    attachments: [...(input.attachments ?? [])].map((a) =>
      a.kind === 'upload'
        ? { kind: a.kind, name: a.name, source: a.source, content: a.content }
        : { kind: a.kind, name: a.name, source: a.source, connectorId: a.connectorId, externalId: a.externalId },
    ),
    // The TEMPLATE'S OBLIGATION DECLARATIONS.
    //
    // These change what a valid distillation must CONTAIN without changing one
    // character of the prompt, so without this they could not move the key. Turn
    // on `requiresIdempotencyCheck` for a template and every agent already
    // hired from it keeps being served the cached graph that has no step
    // checking whether it already acted, because the fence that would have
    // added one runs on the generation path and a cache hit never reaches it.
    //
    // A template can declare an obligation its prose already committed to, and
    // a redistill inside the TTL would return the same graph with the same hole
    // and report success.
    //
    // Read from the template rather than passed in, so a caller cannot forget
    // it. Lazily, for the same circular-dependency reason distill-service
    // requires the loader lazily.
    templateContract: templateContract(input.obligationTemplateId ?? input.templateId),
    // The PRODUCTION STRATEGY.
    //
    // Two strategies produce the same artifact SHAPE from the same input, so
    // without this they collide on one key — and the collision is silent and
    // exactly backwards for the thing the key is being asked to support.
    //
    // The A/B harness runs `single` and then `waved` over one corpus. On the
    // second arm every input is byte-identical to the first, so the second arm
    // would hit this cache, return the FIRST arm's artifact in milliseconds
    // without making an LLM call, and report a near-zero time with perfect
    // quality agreement. The comparison would look like a total success while
    // having measured nothing at all.
    //
    // Including it costs one round of misses when it ships, because every
    // existing key gains a field. That is a one-hour TTL of extra distillations,
    // once, against a comparison that would otherwise be worthless.
    strategy: input.strategy ?? 'single',
    catalogHash,
    // The PRIOR ART section. Prompt text the other inputs do not imply: a
    // blueprint landing between two otherwise-identical runs changes what the
    // model is shown, so it must change the key — the same property that put
    // catalogHash here. '' when the section is absent, so pre-existing keys
    // only churn once, when the feature ships.
    priorArtHash,
  });
  return createHash('sha256').update(normalized).digest('hex');
}

/** Return a cached DistillOutput, or null on miss / expiry. */
export async function getCachedDistillation(fingerprint: string): Promise<DistillOutput | null> {
  try {
    const result = await pool.query<{ result: unknown; expires_at: Date }>(
      `SELECT result, expires_at FROM distillation_cache WHERE fingerprint = $1`,
      [fingerprint],
    );
    const row = result.rows[0];
    if (!row) return null;

    if (row.expires_at < new Date()) {
      // Expired — clean up inline (best-effort, no await on error)
      pool.query(`DELETE FROM distillation_cache WHERE fingerprint = $1`, [fingerprint]).catch(() => {});
      return null;
    }

    return row.result as DistillOutput;
  } catch (err) {
    log.warn({ err, fingerprint }, 'distillation_cache: read failed, treating as miss');
    return null;
  }
}

/** Store a DistillOutput in the cache. Upserts on fingerprint conflict so that
 *  concurrent distillations for the same input don't cause an error. */
export async function setCachedDistillation(
  fingerprint: string,
  tenantId: string,
  result: DistillOutput,
): Promise<void> {
  const expiresAt = new Date(Date.now() + CACHE_TTL_MS);
  try {
    await pool.query(
      `INSERT INTO distillation_cache (fingerprint, tenant_id, result, expires_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (fingerprint) DO UPDATE
         SET result = EXCLUDED.result,
             expires_at = EXCLUDED.expires_at`,
      [fingerprint, tenantId, JSON.stringify(result), expiresAt],
    );
  } catch (err) {
    // Cache write failure is non-fatal — the caller already has the result.
    log.warn({ err, fingerprint }, 'distillation_cache: write failed, continuing without cache');
  }
}
