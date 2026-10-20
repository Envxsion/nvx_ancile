/**
 * ------------------------------------------------------------------
 *  Title    |  Guide chapter: Providers and paying
 *  Ref      |  ROADMAP GD1 · docs/models.md · docs/errors.md
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  What each model provider sells, limits, keeps and
 *           |  allows, so a person can choose how to pay and what to
 *           |  send where. Every article lists its sources and the
 *           |  date they were read.
 *  How      |  Loaded on demand (help/lazyGuide.ts) the first time the
 *           |  guide opens or the palette searches it, so none of this
 *           |  is in the first download. ### headings become section
 *           |  anchors (citeGuide). A sentence in an article's
 *           |  `unconfirmed` list is shown with a "Not yet confirmed"
 *           |  mark; the researched facts are from 20 Oct 2026.
 *  Note     |  Facts come only from the researched entries and the
 *           |  vendors' own pages. "What NVX Ancile does about it"
 *           |  states only what the code does today; anything else is
 *           |  marked planned. Quote vendors' terms, never paraphrase.
 * ------------------------------------------------------------------
 */

import type { Chapter } from './articles';

/** When the facts in this chapter were last read at their sources. */
export const PROVIDERS_CHECKED = '2026-10-20';

export const PROVIDERS_CHAPTER: Chapter = {
  id: 'providers',
  title: 'Providers and paying',
  articles: [
    {
      id: 'pay-ways',
      title: 'Ways to pay for a model',
      summary:
        'Subscription, included credit, prepaid balance, free allowance or your own hardware: what each vendor sells.',
      keywords:
        'pay payment billing cost price how do I pay subscription api key credit prepaid balance pay as you go free tier trial plan limits included credit out of credit top up Claude subscription Included monthly credit Pay as you go',
      checked: PROVIDERS_CHECKED,
      sources: [
        {
          title: 'Using Claude Code with your Pro or Max plan',
          url: 'https://support.claude.com/en/articles/11145838-using-claude-code-with-your-pro-or-max-plan',
        },
        {
          title: 'API credits for Max and Team plans',
          url: 'https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers',
        },
        { title: 'Codex pricing and plans', url: 'https://learn.chatgpt.com/docs/pricing' },
        { title: 'Codex authentication', url: 'https://learn.chatgpt.com/docs/auth' },
        { title: 'Gemini API billing', url: 'https://ai.google.dev/gemini-api/docs/billing' },
        {
          title: 'Google AI plans and the Gemini API',
          url: 'https://ai.google.dev/gemini-api/docs/google-ai-plans',
        },
        { title: 'xAI billing', url: 'https://docs.x.ai/docs/key-information/billing' },
        { title: 'DeepSeek API docs: quick start', url: 'https://api-docs.deepseek.com/' },
        { title: 'DeepSeek models and pricing', url: 'https://api-docs.deepseek.com/quick_start/pricing' },
        {
          title: 'Kimi Code overview and membership guide',
          url: 'https://www.kimi.com/en/help/kimi-code/membership-guide',
        },
        {
          title: 'Kimi Code support on the API platform',
          url: 'https://platform.kimi.ai/docs/guide/kimi-code-support',
        },
        {
          title: 'Kimi Code membership benefits and limits',
          url: 'https://www.kimi.com/en/help/kimi-code/benefits',
        },
        { title: 'Kimi Open Platform rate limit tiers', url: 'https://platform.kimi.ai/docs/pricing/limits' },
        { title: 'MiniMax CLI reference', url: 'https://platform.minimax.io/docs/m-plan/minimax-cli' },
        { title: 'MiniMax M Plan FAQ', url: 'https://platform.minimax.io/docs/token-plan/faq.md' },
        {
          title: 'MiniMax M Plan quick start',
          url: 'https://platform.minimax.io/docs/token-plan/quickstart.md',
        },
        {
          title: 'Use Qwen Code with Model Studio',
          url: 'https://www.alibabacloud.com/help/id/model-studio/qwen-code',
        },
        { title: 'Model Studio error codes', url: 'https://help.aliyun.com/en/model-studio/error-code' },
        { title: 'Coding Plan FAQ', url: 'https://help.aliyun.com/en/model-studio/coding-plan-faq' },
        { title: 'GLM Coding Plan overview', url: 'https://docs.z.ai/devpack/overview' },
        { title: 'GLM Coding Plan FAQ', url: 'https://docs.z.ai/devpack/faq' },
        { title: 'Z.ai pricing', url: 'https://docs.z.ai/guides/overview/pricing' },
        { title: 'Z.ai concepts and parameters', url: 'https://docs.z.ai/guides/overview/concept-param' },
        { title: 'OpenRouter API limits', url: 'https://openrouter.ai/docs/api-reference/limits' },
        { title: 'OpenRouter FAQ', url: 'https://openrouter.ai/docs/faq' },
        { title: 'OpenRouter terms of service', url: 'https://openrouter.ai/terms' },
        {
          title: 'Together build tiers',
          url: 'https://support.together.ai/articles/2650779384-build-tiers-required-spend-and-rate-limits',
        },
        {
          title: 'Together free tier changes July 2025',
          url: 'https://support.together.ai/articles/1862638756-changes-to-free-tier-and-billing-july-2025',
        },
        {
          title: 'Fireworks rate limits and quotas',
          url: 'https://docs.fireworks.ai/guides/quotas_usage/rate-limits',
        },
        { title: 'Cerebras rate limits', url: 'https://inference-docs.cerebras.ai/support/rate-limits' },
        {
          title: 'Workers AI pricing',
          url: 'https://developers.cloudflare.com/workers-ai/platform/pricing/',
        },
        {
          title: 'Inference Providers pricing',
          url: 'https://huggingface.co/docs/inference-providers/pricing',
        },
        { title: 'Ollama pricing', url: 'https://ollama.com/pricing' },
        { title: 'RunPod pod pricing', url: 'https://docs.runpod.io/pods/pricing' },
        { title: 'Claude Code CLI reference', url: 'https://code.claude.com/docs/en/cli-reference' },
        {
          title: 'Use the Claude Agent SDK with your Claude plan',
          url: 'https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan',
        },
        {
          title: 'Copilot moving to usage-based billing',
          url: 'https://github.blog/changelog/2026/04/27/github-copilot-is-moving-to-usage-based-billing/',
        },
        {
          title: 'Copilot premium requests',
          url: 'https://docs.github.com/en/copilot/concepts/billing/copilot-requests',
        },
        { title: 'Cursor pricing', url: 'https://cursor.com/docs/account/pricing' },
        {
          title: 'Monthly API credits for Max and Team plans',
          url: 'https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-and-team-plans',
        },
      ],
      unconfirmed: [
        'Secondary reports say Pro includes $10 of monthly Developer Program credit and Ultra tiers $40 or $100, but we could not confirm the amounts on an official page.',
      ],
      body: `Every model in NVX Ancile is paid for in one of a few ways, and the way is shown beside the model so that two bills are never mixed up. This article lists the ways vendors sell access. Each vendor has its own article with the details and the dates they were checked.

### The three Claude routes

NVX Ancile uses three names for Claude, and keeps them apart:

- **Claude subscription**: your plan's usage limits, used through Claude Code.
- **Included monthly credit**: an API key from the Claude Console organisation linked to a Max or Team plan.
- **Pay as you go**: API credit you buy in the Claude Console.

A Claude subscription (Pro, Max, Team) gives usage limits through the Claude Code login. Max and Team plans also include a monthly API credit that is spent by API keys in a linked Console organisation. Pay-as-you-go API credit is a third, separate balance. The Agent SDK and \`claude -p\` signed in with the plan use plan limits, not the included credit. Anthropic says: "When you're signed in with your Claude plan instead, claude -p and Agent SDK usage still draw from your plan's usage limits and don't use your API credits."

Claude Code can sign in with a subscription, with Claude Console API billing, or with a cloud provider such as Amazon Bedrock. Subscription use draws on plan limits; API use bills per token.

### Subscriptions with usage limits

These sell an allowance of use, not a price per token:

- **Claude (Pro, Max, Team)** and **ChatGPT plans**. Signing in to Codex with ChatGPT uses your plan allowance. Signing in with an API key bills your OpenAI Platform account at standard API rates. Plus and standard Business plans have a five-hour window plus weekly limits.
- **Kimi Code membership**, **MiniMax subscription keys**, the **Z.ai GLM Coding Plan** and **Alibaba's Token Plan and Coding Plan**. Each has its own key kind and its own endpoint. Plan keys cannot be mixed with general endpoints.
- **Cursor**: each paid plan has one pool of usage for Cursor models, shared across the editor agent, the CLI and cloud agents, and it refreshes weekly.
- **GitHub Copilot**: from 1 June 2026 it bills AI Credits by token, but annual subscribers stay on premium request billing until their plan expires.

### Prepaid balances

You buy credit first and calls draw it down:

- **xAI**: the standard route is to buy credits that API use draws down.
- **DeepSeek**: access is by prepaid balance. There is no consumer-subscription route.
- **Kimi platform**: you must recharge at least $1 to start.
- **Together**: access needs a minimum $5 credit purchase and no free trial is offered.
- **Fireworks**: bills from prepaid credits.
- **OpenRouter**: credits carry a 5.5% fee ($0.80 minimum) on card purchases.
- **Google Gemini API**: upgrading means linking a billing account and prepaying at least $5, or being on postpay.

### Free allowances

- **Google** new projects start on the free tier.
- **Cohere** gives every new user a free, rate-limited trial key.
- **Cloudflare Workers AI** gives 10,000 neurons a day on both Free and Paid plans.
- **Cerebras** has a small free trial with its own limits, and **Groq** has Free and Developer plans with different allocations.
- **OpenRouter** models with the \`:free\` suffix allow 50 requests a day until you buy credits.
- **Alibaba Model Studio** gives new users a free quota for 90 days, for Singapore only.
- **Z.ai** lists GLM-4.7-Flash and GLM-4.5-Flash with input and output priced "Free". Newer Flash models are paid.
- **Hugging Face**: Free users get no included credit and must buy credits to use Inference Providers.

### Credits that come with something else

- Max 5x gets $100 and Max 20x gets $200 a month. Team gets $20 per Standard seat and $100 per Premium seat, pooled and capped at $500. Unused credit expires each billing cycle.
- Hugging Face PRO gets $2.00 a month, and Team or Enterprise gets $2.00 per seat.
- Ollama cloud: Pro is $20 a month with $60 of usage credits, and Max is $100 with $300. Included usage resets monthly and unused usage does not carry over.
- Google says AI plan benefits apply only in the Google AI Studio web interface, and direct Gemini API use with keys or external apps is billed separately. Secondary reports say Pro includes $10 of monthly Developer Program credit and Ultra tiers $40 or $100, but we could not confirm the amounts on an official page.

### Your own hardware

A model on your computer or network (Ollama, LM Studio) has no key and no bill. A rented GPU on RunPod bills by the second for compute and storage.

### What NVX Ancile does about it

- It labels each model by how it is paid: Plan, Key, Included credit, Local, GPU node, Rented or Test. The three Claude routes above show as separate models and are never added into one balance.
- The included monthly credit has its own meter on the Anthropic key card and in Settings, Usage. It is NVX Ancile's own count of spend made through the key.
- Ordering several payment sources for one model, with a limit on each, is planned (PS1).
- Subscriptions from other vendors are not used as API credentials. See "Using your subscriptions in NVX Ancile".`,
    },
    {
      id: 'balance-order',
      title: 'Which balance is spent first',
      summary:
        'When you have a plan, credits and a card, which one pays, and when a plan never falls back to your card.',
      keywords:
        'balance spent first order credit expire which balance included credit purchased auto-reload fallback free quota resource plan out of credit BYOK shared capacity run out',
      checked: PROVIDERS_CHECKED,
      sources: [
        {
          title: 'API credits for Max and Team plans',
          url: 'https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers',
        },
        { title: 'Claude API rate limits', url: 'https://platform.claude.com/docs/en/api/rate-limits' },
        { title: 'Gemini API billing', url: 'https://ai.google.dev/gemini-api/docs/billing' },
        {
          title: 'Kimi Code membership benefits and limits',
          url: 'https://www.kimi.com/en/help/kimi-code/benefits',
        },
        {
          title: 'Kimi Code overview and membership guide',
          url: 'https://www.kimi.com/en/help/kimi-code/membership-guide',
        },
        { title: 'MiniMax M Plan FAQ', url: 'https://platform.minimax.io/docs/token-plan/faq.md' },
        {
          title: 'Free quota for new users',
          url: 'https://www.alibabacloud.com/help/en/model-studio/new-free-quota.md',
        },
        { title: 'Coding Plan FAQ', url: 'https://help.aliyun.com/en/model-studio/coding-plan-faq' },
        { title: 'Token Plan FAQ', url: 'https://help.aliyun.com/en/model-studio/token-plan-faq' },
        { title: 'GLM Coding Plan FAQ', url: 'https://docs.z.ai/devpack/faq' },
        { title: 'OpenRouter API limits', url: 'https://openrouter.ai/docs/api-reference/limits' },
        { title: 'OpenRouter FAQ', url: 'https://openrouter.ai/docs/faq' },
        { title: 'OpenRouter BYOK', url: 'https://openrouter.ai/docs/guides/overview/auth/byok' },
        {
          title: 'Fireworks rate limits and quotas',
          url: 'https://docs.fireworks.ai/guides/quotas_usage/rate-limits',
        },
        {
          title: 'Inference Providers pricing',
          url: 'https://huggingface.co/docs/inference-providers/pricing',
        },
        {
          title: 'Monthly API credits for Max and Team plans',
          url: 'https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-and-team-plans',
        },
      ],
      body: `Most vendors let more than one balance sit behind one key. This article says which is used first, and where the answer is surprising: a plan that never falls back to your card, a free allowance that quietly becomes paid, or a key that falls back to someone else's capacity.

### Anthropic: included credit, then purchased credit

Every API key and workspace in the linked Console organisation draws from one balance. Included credits are spent first, then credits you bought. Auto-reload looks only at the purchased balance, so it can top up while included credit remains.

Unused included credit expires at the end of each billing cycle and does not roll over. A spend cap resets on a different clock: the tier caps reset at 00:00 UTC on the first of the month, while included credit refreshes on the plan billing cycle.

### Alibaba: free quota first, and then it can turn paid

The documented order is: "The system automatically applies deductions in the following priority order: free quota > resource plan > savings plan > pay-as-you-go." If "Free Quota Only" mode is on, the service stops with AllocationQuota.FreeTierOnly when the quota runs out. If it is off, calls continue at pay-as-you-go rates.

A plan never falls back to pay as you go. The Coding Plan FAQ says: "further API calls will fail with an error, and usage will not automatically switch to pay-as-you-go."

### Plans that never touch your balance

- **Z.ai**: "Once the quota is used up, you'll need to wait until the next 5-hour cycle for it to refresh. The system will not deduct from your account balance."
- **MiniMax**: a subscription key accesses "M Plan benefits and credit packs", while the standard API key "enables pay-as-you-go billing without plan limits". A plan key never spends your pay-as-you-go balance.
- **Kimi Code**: a membership draws on a monthly total quota. When it runs out, members can switch on "Extra Usage", a separate pay-as-you-go balance. The Open Platform balance is a different wallet.

### Hugging Face: credits before pay as you go

Monthly credits are general compute credits that can also pay for Inference Endpoints, Spaces hardware and Jobs, and they apply before pay-as-you-go billing. If you set your own provider key in Hugging Face settings, the provider bills you directly and the included credits do not apply.

### OpenRouter: your key, then shared capacity

Using your own provider keys costs 5% of what the same model and provider would cost normally on OpenRouter, and the fee is taken from your OpenRouter credits. If every key hits a rate limit or fails, OpenRouter falls back to its own shared endpoints by default, so your request is billed to credits instead of your key. You can switch this off per provider, at the cost of rate-limit errors.

A negative balance blocks free models too, with a 402. The free-model daily cap counts purchases, not your current balance.

### Fireworks: a spend limit a top-up does not fix

Adding credits does not raise or reset a monthly spend limit you have set. A user who has credits but hits the limit will see failures that a top-up does not fix.

### Google: all keys in a project stop together

API keys take the tier and billing status of their Google Cloud project, and all keys in a project count toward its spend cap. On prepay, when the balance reaches $0 every API key in the project stops at once.

### What NVX Ancile does about it

- It never merges the Claude routes into one number. The included monthly credit has its own meter, and its cycle end is shown. A Claude subscription is shown as plan limits.
- When Anthropic says the included credit is gone, models paid from it are marked and skipped until the cycle ends. Nothing is retried, and nothing is charged to your plan.
- An optional goal, "Spend expiring credit first", puts a credit-paid model ahead of an earlier model of the same Claude line in the last days of a cycle. It is off by default.
- NVX Ancile never switches payer by itself, including when a plan's limit is reached. It offers other models as an explicit choice and says when one bills an API key.
- Choosing the order of several payment sources for one model, with a limit on each, is planned (PS1).`,
    },
    {
      id: 'subscription-terms',
      title: 'Using your subscriptions in NVX Ancile',
      summary:
        "What each vendor's terms allow for plan logins and plan keys, quoted, and what NVX Ancile does so you stay inside them.",
      keywords:
        'subscription terms allowed terms of service can I use my Claude subscription ChatGPT Plus plan key third party app Max plan login OAuth ban suspended account Claude Pro Max Codex Gemini CLI Kimi Code Coding Plan Z.ai Alibaba MiniMax Cursor',
      checked: PROVIDERS_CHECKED,
      sources: [
        {
          title: 'Claude Code legal and compliance',
          url: 'https://code.claude.com/docs/en/legal-and-compliance',
        },
        { title: 'Agent SDK overview', url: 'https://code.claude.com/docs/en/agent-sdk/overview' },
        {
          title: 'Sign in with ChatGPT for developers',
          url: 'https://developers.openai.com/siwc/token-sharing-open-source/sign-in',
        },
        {
          title: 'Sign in with ChatGPT terms',
          url: 'https://openai.com/policies/sign-in-with-chatgpt-terms/',
        },
        { title: 'Gemini CLI terms and privacy', url: 'https://geminicli.com/docs/resources/tos-privacy/' },
        { title: 'Cohere going live', url: 'https://docs.cohere.com/docs/going-live' },
        {
          title: 'DeepSeek Open Platform terms of service',
          url: 'https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html',
        },
        {
          title: 'Kimi Code community guidelines',
          url: 'https://www.kimi.com/code/docs/en/kimi-code/community-guidelines.html',
        },
        {
          title: 'Kimi Code overview and membership guide',
          url: 'https://www.kimi.com/en/help/kimi-code/membership-guide',
        },
        { title: 'MiniMax M Plan FAQ', url: 'https://platform.minimax.io/docs/token-plan/faq.md' },
        {
          title: 'MiniMax subscription service terms',
          url: 'https://agent.minimax.io/doc/en/payment-policy.html',
        },
        { title: 'Coding Plan FAQ', url: 'https://help.aliyun.com/en/model-studio/coding-plan-faq' },
        {
          title: 'Token Plan Personal Edition',
          url: 'https://help.aliyun.com/en/model-studio/token-plan-personal-overview',
        },
        {
          title: 'Token Plan Team Edition',
          url: 'https://help.aliyun.com/en/model-studio/token-plan-team-overview',
        },
        { title: 'Token Plan FAQ', url: 'https://help.aliyun.com/en/model-studio/token-plan-faq' },
        { title: 'GLM Coding Plan FAQ', url: 'https://docs.z.ai/devpack/faq' },
        { title: 'GLM Coding Plan usage policy', url: 'https://docs.z.ai/devpack/usage-policy' },
        { title: 'GLM Coding Plan overview', url: 'https://docs.z.ai/devpack/overview' },
        { title: 'Codex CLI commands', url: 'https://learn.chatgpt.com/docs/developer-commands?surface=cli' },
        { title: 'OpenCode providers', url: 'https://opencode.ai/docs/providers/' },
        { title: 'Cursor terms of service', url: 'https://cursor.com/terms-of-service' },
        { title: 'Kimi Code membership guide', url: 'https://www.kimi.com/help/kimi-code/membership-guide' },
        { title: 'Kimi Code docs', url: 'http://www.kimi.com/code/docs/' },
        {
          title: 'Monthly API credits for Max and Team plans',
          url: 'https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-and-team-plans',
        },
      ],
      unconfirmed: [
        'The terms page reportedly also bars using the plan for general-purpose API access to other tools, which we could not read directly.',
        "Whether a ChatGPT login may be used inside other apps is not confirmed, because OpenAI's terms page could not be read (403).",
        "Search results from Kimi's help pages say the benefit is for personal development only, and that programming use must stay within Kimi CLI and agents on the approved list. The official docs page we fetched confirms the User-Agent rule but not the rest.",
        'A search summary of a news report says Kimi Code wrongly flagged third-party agents that imitated the Kimi CLI, and settled with the open-source community on 26 May 2026.',
        'A third-party summary says the plan is for individual interactive use; the official page we could read does not state an automation ban.',
        'The Team Edition FAQ says it supports "any tool that supports custom Base URL and API Key", while the Coding Plan FAQ lists a closed set of programming tools. The two pages disagree, and neither names general AI workspaces.',
        "Cursor's terms prohibit renting, leasing, lending or selling the service, and using it to build a competing model. They do not specifically address using the CLI or account inside other apps.",
      ],
      body: `A subscription is sold for use in the vendor's own apps. Some vendors allow it elsewhere, some do not, and some have not said. Below are the words each vendor uses, quoted, so you can judge for yourself. Where a vendor has not said, this article says so.

### Anthropic (Claude Free, Pro, Max)

> "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users."

Developers, including those using the Agent SDK, should use API keys. The unmodified Claude Code binary signed in by the end user is the allowed route. The compliance page also says that advertised Pro and Max limits assume ordinary individual usage.

The Agent SDK overview adds: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK."

For hosting Claude Code inside another product, the terms require the Commercial Terms, an unmodified binary with its authentication methods left intact, and that customers do not pay for, resell or intermediate Claude usage on end users' behalf. Each end user must authenticate with their own API key, subscription or cloud credential.

OpenCode's own documentation agrees: plugins that let you use Claude Pro or Max models in OpenCode exist but "Anthropic explicitly prohibits this".

### Google (Gemini CLI)

> "Directly accessing the services powering Gemini CLI (for example, the Gemini Code Assist service) using third-party software, tools, or services (for example, using OpenClaw with Gemini CLI OAuth) is a violation of applicable terms and policies."

The page adds that this may be grounds for suspension or termination.

### OpenAI (ChatGPT plans and Codex)

OpenAI's developer docs say that when an app uses ChatGPT tokens through Sign in with ChatGPT, "the user's ChatGPT plan usage limits are consumed", not the developer's API quota. The terms page reportedly also bars using the plan for general-purpose API access to other tools, which we could not read directly. Whether a ChatGPT login may be used inside other apps is not confirmed, because OpenAI's terms page could not be read (403). OpenCode's docs say ChatGPT Plus and Pro work in OpenCode through browser sign-in, which is OpenCode's statement and not OpenAI's.

### Kimi Code membership

The community guidelines say: "Don't spoof or alter client identity information", "Don't use Kimi Code for non-interactive automation", and "Don't resell your account or API access". Third-party tools such as Claude Code, OpenCode and OpenClaw are explicitly supported, and using several devices and tools at once is described as normal. Enforcement includes concurrency limits with the error "You've reached your concurrent request limit."

Search results from Kimi's help pages say the benefit is for personal development only, and that programming use must stay within Kimi CLI and agents on the approved list. The official docs page we fetched confirms the User-Agent rule but not the rest. A search summary of a news report says Kimi Code wrongly flagged third-party agents that imitated the Kimi CLI, and settled with the open-source community on 26 May 2026.

### MiniMax subscription

The FAQ says subscription keys work "with any AI tool that supports the OpenAI-compatible or Anthropic-compatible protocol". Separately the subscription terms say "You may not lend, share, transfer, or otherwise permit others to use your account", and credits may not be used "for profit, commercial transactions, transfers, sales, or other non-personal purposes". A third-party summary says the plan is for individual interactive use; the official page we could read does not state an automation ban.

### Alibaba Model Studio (Coding Plan, Token Plan)

The Coding Plan FAQ says the plan is "exclusively for use within programming tools, such as Claude Code and Qwen Code, and is not supported in tools like curl, Postman, or Dify." Token Plan says it is "intended for interactive use only within coding tools", and that automation scripts, application backends and batch API calls may lead to suspension or key revocation. Personal plans must not be shared.

The Team Edition FAQ says it supports "any tool that supports custom Base URL and API Key", while the Coding Plan FAQ lists a closed set of programming tools. The two pages disagree, and neither names general AI workspaces.

### Z.ai GLM Coding Plan

> "The GLM Coding Plan is strictly limited to use within officially supported tools and products. The subscriber shall not use the subscription benefits in any unsupported tools or scenarios."

The usage policy adds that "Account sharing or multi-user access is prohibited" and that accounts with more than three violations may be banned. Named tools include Claude Code, Cline, OpenCode, Codex, ZCode, AutoClaw and OpenClaw, and the list changes.

### Cursor and Cohere

Cursor's terms prohibit renting, leasing, lending or selling the service, and using it to build a competing model. They do not specifically address using the CLI or account inside other apps. Cohere's going-live page says trial keys are rate-limited and not suitable for production deployment.

### DeepSeek

Section 4.2 of the Open Platform terms says you "may apply the Inputs and Outputs of the Services to a wide range of use cases, including personal use, academic research, derivative product development". Section 2.2 says: "do not share or publicly disclose your API key with others".

### What NVX Ancile does about it

- It uses an API key for Anthropic. The plan route is only your own, unmodified Claude Code, installed and signed in by you: NVX Ancile finds it, checks it is Anthropic's, and drives it through Anthropic's Agent SDK. It never reads Claude Code's sign-in files and never sees your Claude password or tokens.
- It does not offer a ChatGPT, Claude Pro or Max login as an API route. The models page says: "Claude Pro or Max and ChatGPT Plus or Pro are subscriptions to the providers' own apps. They are not API credentials, and the providers do not offer them for other apps to call."
- Plan keys from MiniMax, Alibaba, Z.ai and Kimi Code cannot be told from ordinary keys by NVX Ancile today. A warning for interactive-only plan keys is planned.
- A shared NVX Ancile install must not use one person's subscription for several people.`,
    },
    {
      id: 'chat-storage',
      title: 'Where your chat is saved',
      summary:
        "NVX Ancile's own folder against each coding engine's folder, and which engines can run without saving.",
      keywords:
        'where is my chat saved storage folder transcripts delete session no save ephemeral persistSession history privacy .claude .codex .gemini .kimi .qwen .copilot opencode remove my data keep nothing run without saving delete engine copies',
      checked: PROVIDERS_CHECKED,
      sources: [
        { title: 'Claude Code data usage', url: 'https://code.claude.com/docs/en/data-usage' },
        { title: 'Codex authentication', url: 'https://learn.chatgpt.com/docs/auth' },
        { title: 'Gemini CLI authentication', url: 'https://geminicli.com/docs/get-started/authentication/' },
        { title: 'DeepSeek API docs: quick start', url: 'https://api-docs.deepseek.com/' },
        {
          title: 'Kimi Code CLI data locations',
          url: 'https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/data-locations.html',
        },
        { title: 'MiniMax CLI reference', url: 'https://platform.minimax.io/docs/m-plan/minimax-cli' },
        {
          title: 'Use Qwen Code with Model Studio',
          url: 'https://www.alibabacloud.com/help/id/model-studio/qwen-code',
        },
        { title: 'Coding Tool Helper', url: 'https://docs.z.ai/devpack/extension/coding-tool-helper.md' },
        { title: 'ZCode setup', url: 'https://docs.z.ai/devpack/tool/zcode.md' },
        { title: 'Ollama FAQ', url: 'https://docs.ollama.com/faq' },
        { title: 'RunPod network volumes', url: 'https://docs.runpod.io/storage/network-volumes' },
        { title: 'LM Studio download a model', url: 'https://lmstudio.ai/docs/app/basics/download-model' },
        { title: 'Explore the .claude directory', url: 'https://code.claude.com/docs/en/claude-directory' },
        { title: 'Claude Code sessions', url: 'https://code.claude.com/docs/en/sessions' },
        { title: 'Agent SDK sessions', url: 'https://code.claude.com/docs/en/agent-sdk/sessions' },
        { title: 'Claude Code CLI reference', url: 'https://code.claude.com/docs/en/cli-reference' },
        {
          title: 'Codex advanced configuration',
          url: 'https://learn.chatgpt.com/docs/config-file/config-advanced',
        },
        { title: 'Codex CLI commands', url: 'https://learn.chatgpt.com/docs/developer-commands?surface=cli' },
        {
          title: 'Gemini CLI session management',
          url: 'https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/session-management.md',
        },
        {
          title: 'Gemini CLI enterprise',
          url: 'https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/enterprise.md',
        },
        {
          title: 'About Copilot CLI session data',
          url: 'https://docs.github.com/en/copilot/concepts/agents/copilot-cli/chronicle',
        },
        {
          title: 'Copilot CLI command reference',
          url: 'https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference',
        },
        { title: 'Using Cursor CLI', url: 'https://cursor.com/docs/cli/using' },
        { title: 'Cursor CLI authentication', url: 'https://cursor.com/docs/cli/reference/authentication' },
        {
          title: 'Qwen Code settings',
          url: 'https://qwenlm.github.io/qwen-code-docs/en/users/configuration/settings/',
        },
        {
          title: 'Kimi data locations',
          url: 'https://moonshotai.github.io/kimi-cli/en/configuration/data-locations.html',
        },
        { title: 'OpenCode CLI', url: 'https://opencode.ai/docs/cli/' },
        { title: 'OpenCode troubleshooting', url: 'https://opencode.ai/docs/troubleshooting/' },
      ],
      unconfirmed: [
        'no official flag or setting equivalent to persistSession false was found; the sessionRetention enabled switch controls automatic cleanup, not whether sessions are written.',
        'the docs we read did not state whether a run can skip saving, or how to delete one.',
        'It reads `.env` files from the current folder and parents, then `~/.gemini/.env`, and caches the Google sign-in locally, though the exact credential file path was not stated.',
        '`agent ls` lists previous chats and `agent resume` resumes the latest; the storage path and a delete command were not confirmed.',
        'LM Studio lets you change the models directory under My Models, but the default path was not stated on the page we read.',
      ],
      body: `Two places can hold a conversation: NVX Ancile and the engine that answered. Deleting a thread in NVX Ancile does not delete what an engine wrote in its own folder.

### NVX Ancile's own copy

NVX Ancile keeps your threads in its own database on this computer. Memory, uploads, backups and exports sit in its data folder. Deleting a thread moves it to the Trash, which keeps it for 30 days.

### Claude Code

Claude Code is the engine NVX Ancile drives today, and it keeps a copy of its own.

- Transcripts are JSONL files at \`~/.claude/projects/<project>/<session-id>.jsonl\`, where \`<project>\` is the working directory with non-alphanumeric characters replaced by a hyphen. They are plaintext and include file contents and command output from tools.
- They are deleted after \`cleanupPeriodDays\` (default 30, minimum 1). \`CLAUDE_CONFIG_DIR\` moves everything.
- Claude Code stores session transcripts locally in plaintext for 30 days by default. If you use \`/feedback\` with a third-party provider it may write a bundle to \`~/.claude/feedback-bundles/\`.
- Sessions created with \`claude -p\` or the Agent SDK are left out of the picker and out of \`claude --continue\`, though they can be resumed by ID.
- \`claude purge [path]\` deletes a project's transcripts, task lists, debug logs, file-edit history, prompt history lines and the project entry in \`~/.claude.json\`, with \`--dry-run\` to preview. \`claude rm\` removes a background session from the list but its transcript stays on disk and remains resumable.

### Running without saving

- **Claude Code**: in the TypeScript Agent SDK, \`persistSession: false\` keeps the session in memory only. In Python, set \`CLAUDE_CODE_SKIP_PROMPT_HISTORY\` in the env option. On the CLI, \`--no-session-persistence\` works with \`-p\` only. A non-persisted session cannot be resumed.
- **OpenAI Codex**: \`codex exec --ephemeral\` runs without persisting session rollout files.
- **Qwen Code**: the \`general.chatRecording\` setting controls saving chat history, and disabling it also stops \`--continue\` and \`--resume\` working.
- **Gemini CLI**: no official flag or setting equivalent to persistSession false was found; the sessionRetention enabled switch controls automatic cleanup, not whether sessions are written.
- **GitHub Copilot CLI**: no confirmed flag runs a session without saving it.
- **Cursor CLI**: the docs we read did not state whether a run can skip saving, or how to delete one.
- **Kimi CLI** and **OpenCode**: no documented no-save mode was found.

### Other engines' folders

NVX Ancile has no engine for these yet, so nothing is written there by NVX Ancile. They matter if you also use them in a terminal.

- **OpenAI Codex**: local state, \`config.toml\`, history and logs under \`CODEX_HOME\`, which defaults to \`~/.codex\`. \`auth.json\` is kept there if file-based credential storage is chosen. OpenAI says to treat \`auth.json\` like a password. \`codex delete\` permanently deletes a saved interactive session.
- **Gemini CLI**: sessions are under \`~/.gemini/tmp/<project_hash>/chats/\`, kept 30 days by default. Delete with \`--delete-session\`. It reads \`.env\` files from the current folder and parents, then \`~/.gemini/.env\`, and caches the Google sign-in locally, though the exact credential file path was not stated.
- **GitHub Copilot CLI**: local sessions are under \`~/.copilot/session-state/\`. By default locally run sessions are synced to your GitHub account. Opt out with \`remoteExport\` false in CLI settings. Tokens go in the system credential store, or in a plaintext config file under \`~/.copilot/\` if no store exists.
- **Cursor CLI**: \`agent ls\` lists previous chats and \`agent resume\` resumes the latest; the storage path and a delete command were not confirmed.
- **Qwen Code**: settings in \`~/.qwen/settings.json\`; \`QWEN_HOME\` can change the data location. The exact sessions folder and a delete command were not confirmed.
- **Kimi CLI**: data in \`~/.kimi/\`, sessions in \`~/.kimi/sessions/\` organised by working directory hash. Delete by removing the sessions folder or using \`/sessions\` in shell mode. Kimi Code CLI keeps everything under \`~/.kimi-code\`, including OAuth credentials.
- **OpenCode**: data and \`auth.json\` in \`~/.local/share/opencode/\`. \`opencode session delete <id>\` deletes a session, and \`opencode export --sanitize\` helps before sharing one.

### Local model servers

Ollama stores models in \`~/.ollama/models\` on macOS, \`/usr/share/ollama/.ollama/models\` on Linux (service install) and \`C:\\Users\\%username%\\.ollama\\models\` on Windows. Set \`OLLAMA_MODELS\` to use another directory. LM Studio lets you change the models directory under My Models, but the default path was not stated on the page we read.

### Vendors that keep a copy on their side

Whether a vendor keeps your prompts is a separate question, covered in "Free tiers and your data". For Claude Code, the \`/feedback\`, \`/bug\` and \`/share\` commands send the transcript, retained for 5 years.

### What NVX Ancile does about it

- It reads Claude Code's sessions from \`~/.claude/projects\` and shows them as threads. It never modifies Claude Code and never reads its sign-in files. It follows \`CLAUDE_CONFIG_DIR\` where it is set.
- It stores the Claude Code session id with the thread, so a thread can carry on the right session.
- A "do not save this run" switch for Claude Code and a way to delete engine copies are planned (CS1). Today NVX Ancile does not set \`persistSession\` and does not run \`claude purge\`.
- Other coding CLIs are not engines in NVX Ancile yet.`,
    },
    {
      id: 'free-data',
      title: 'Free tiers and your data',
      summary: 'Which vendors may train on what you send, who may read it, and how long it is kept.',
      keywords:
        'does X train on my data train training privacy free tier human review retention zero data retention ZDR logging prompts stored data policy opt out private Google Gemini free Mistral free Cohere DeepSeek China Kimi MiniMax OpenRouter Groq Together Fireworks Cerebras Cloudflare Ollama cloud',
      checked: PROVIDERS_CHECKED,
      sources: [
        { title: 'Claude Code data usage', url: 'https://code.claude.com/docs/en/data-usage' },
        { title: 'OpenAI data controls', url: 'https://developers.openai.com/api/docs/guides/your-data' },
        { title: 'Gemini API additional terms', url: 'https://ai.google.dev/gemini-api/terms' },
        { title: 'Gemini API pricing', url: 'https://ai.google.dev/gemini-api/docs/pricing' },
        { title: 'Gemini CLI terms and privacy', url: 'https://geminicli.com/docs/resources/tos-privacy/' },
        {
          title: 'Vertex AI zero data retention',
          url: 'https://docs.cloud.google.com/vertex-ai/generative-ai/docs/vertex-ai-zero-data-retention',
        },
        {
          title: 'Does Mistral use my data to train models',
          url: 'https://help.mistral.ai/en/articles/347617-do-you-use-my-user-data-to-train-your-artificial-intelligence-models',
        },
        { title: 'Cohere enterprise data commitments', url: 'https://cohere.com/data-usage-policy' },
        {
          title: 'Perplexity privacy and security',
          url: 'https://docs.perplexity.ai/docs/resources/privacy-security.md',
        },
        {
          title: 'DeepSeek privacy policy',
          url: 'https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html',
        },
        {
          title: 'Kimi API data processing and security',
          url: 'https://www.kimi.com/en/help/kimi-api/api-data-security',
        },
        {
          title: 'Kimi Open Platform privacy policy',
          url: 'https://platform.kimi.ai/docs/agreement/userprivacy',
        },
        { title: 'MiniMax API privacy policy', url: 'https://platform.minimax.io/protocol/privacy-policy' },
        { title: 'MiniMax terms of service', url: 'https://www.minimax.io/terms-of-service-v2.html' },
        {
          title: 'What is Model Studio',
          url: 'https://help.aliyun.com/en/model-studio/what-is-model-studio',
        },
        {
          title: 'Token Plan Team Edition',
          url: 'https://help.aliyun.com/en/model-studio/token-plan-team-overview',
        },
        { title: 'Token Plan FAQ', url: 'https://help.aliyun.com/en/model-studio/token-plan-faq' },
        {
          title: 'Z.ai privacy policy and data processing addendum',
          url: 'https://docs.z.ai/legal-agreement/privacy-policy.md',
        },
        {
          title: 'TechNode: Zhipu open sources ZCode after data dispute',
          url: 'https://technode.com/2026/09/21/zhipu-open-sources-zcode-after-data-dispute-and-plans-no-retention-controls-for-maas/',
        },
        { title: 'OpenRouter provider routing', url: 'https://openrouter.ai/docs/features/provider-routing' },
        { title: 'OpenRouter zero data retention', url: 'https://openrouter.ai/docs/guides/features/zdr' },
        { title: 'OpenRouter FAQ', url: 'https://openrouter.ai/docs/faq' },
        {
          title: 'OpenRouter privacy and logging',
          url: 'https://openrouter.ai/docs/features/privacy-and-logging',
        },
        { title: 'Groq your data', url: 'https://console.groq.com/docs/your-data' },
        { title: 'Together privacy policy', url: 'https://www.together.ai/privacy' },
        {
          title: 'Fireworks data handling',
          url: 'https://docs.fireworks.ai/guides/security_compliance/data_handling',
        },
        {
          title: 'Does Cerebras retain my data',
          url: 'https://cerebras-inference.help.usepylon.com/articles/1811589793-does-cerebras-retain-my-data',
        },
        { title: 'Cerebras privacy policy', url: 'https://www.cerebras.ai/privacy-policy' },
        {
          title: 'Workers AI data usage',
          url: 'https://developers.cloudflare.com/workers-ai/platform/data-usage/',
        },
        {
          title: 'Inference Providers overview',
          url: 'https://huggingface.co/docs/inference-providers/index',
        },
        { title: 'Ollama cloud', url: 'https://docs.ollama.com/cloud' },
        { title: 'Ollama terms', url: 'https://ollama.com/terms' },
        {
          title: 'Gemini CLI enterprise',
          url: 'https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/enterprise.md',
        },
        {
          title: 'Responsible use of Copilot CLI',
          url: 'https://docs.github.com/en/copilot/responsible-use/copilot-cli',
        },
        { title: 'Cursor data use', url: 'https://cursor.com/data-use' },
        { title: 'Cursor security', url: 'https://cursor.com/security' },
        { title: 'Qwen Code repository', url: 'https://github.com/QwenLM/qwen-code' },
        { title: 'OpenCode Zen', url: 'https://opencode.ai/docs/zen/' },
      ],
      unconfirmed: [
        'A search summary says the Open Platform privacy policy names Singapore servers, which we could not confirm on the page.',
        'Cerebras states that it does not retain prompt content, requests, responses or logs, and describes inference as processed in US-based data centres. This came from a help-centre article and the privacy policy via search, not read directly from a docs page.',
        'Search results say API data is stored in a United States data centre, and a third-party analysis says the API terms let MiniMax use input and generated content to improve its services, with no opt-out. We could not read the privacy and terms pages.',
        'the pages we read describe billing and routing but not a single retention or training policy, so the policy of whichever provider serves the request applies.',
        'Ollama says it processes cloud prompts and responses to answer requests and does not use them to train models; retention periods and hosting regions are not stated on the pages we read.',
        'the CLI page does not itself say whether prompts are used for training; it points to separate notices by sign-in route.',
        'the responsible use page does not state retention periods or training use for GitHub-hosted models. With a bring-your-own model provider, prompts go directly to that provider and not through GitHub.',
        'prompts go to whichever provider you configure; a separate Terms of Service and Privacy Notice were not read in full.',
      ],
      body: `Free does not always mean private. This article collects what each vendor says about training, human review and retention. It is a summary of what they publish, not legal advice, and policies change: each vendor article links to the source and the date it was checked.

### Free tiers that may use your content

- **Google Gemini API**: for free services, Google uses submitted content and responses to improve its products, and human reviewers may read, annotate and process API input and output. For paid services Google says it does not use prompts or responses to improve its products. Both tiers log prompts for a limited period to detect misuse.
- **Mistral**: Studio Free data may be used for model improvement unless you opt out, while pay-as-you-go users keep control and can opt out any time. Using the rating buttons authorises use of that feedback regardless of plan.
- **OpenCode Zen**: during promotional periods data from free models such as Big Pickle may be used to improve the model.
- **Anthropic consumer plans**: for Free, Pro and Max (including Claude Code) data is used for training when the setting is on, with 5-year retention if allowed and 30 days if not.

### Paid keys that say they do not train

- **Anthropic API and Team**: not used for training unless the customer opts in, with 30-day standard retention.
- **OpenAI API**: abuse monitoring logs are kept for up to 30 days unless the law requires longer, and API data is not used for training unless you opt in.
- **Perplexity**: "Perplexity does not use Customer Content to train generative AI models" under the API terms. Zero data retention needs a written agreement.
- **Kimi API**: "User data submitted via the API, including input content and model outputs, will not be used to train or improve Kimi models." A search summary says the Open Platform privacy policy names Singapore servers, which we could not confirm on the page.
- **Alibaba Model Studio**: "Alibaba Cloud protects data privacy and will never use your data for model training." Token Plan Team says "Conversation data is not used for model training". The Personal edition does not carry the same statement.
- **Z.ai**: the Data Processing Addendum says "The Company do not store any of the content the Customer or its End Users provide or generate while using our Services." Batch and File API data and data kept for legal or abuse reasons may still be retained.
- **Cloudflare Workers AI**: Cloudflare says it does not use Customer Content processed by Workers AI to train AI models, and standard inference does not retain inputs or outputs after delivery.
- **Together**: it will not use your data to train its models without explicit opt-in, but by default it retains prompts and responses. Zero Data Retention is an account setting.

### Vendors that say they may train unless you switch it off

- **Cohere**: training use is controlled by a Data Controls toggle in Settings on the Cohere Platform, and secondary sources say the default is on. Logged prompts and generations are deleted after 30 days unless the law or a contract requires longer.
- **DeepSeek**: the privacy policy says DeepSeek will "directly collect, process and store your Personal Data in People's Republic of China". It lists training and improving its models as a purpose, and says users have "the right to opt-out of using your Personal Data for training our models". It is a general policy, not an API-specific one.
- **Cursor**: with Privacy Mode on, Cursor does not train on your data. With it off, Cursor may store and use code data and prompts to train its models. Even with your own API key, requests still go through Cursor's backend.

### Retention, in short

- **Groq** does not retain customer inference data by default. Logs may be kept for up to 30 days when troubleshooting errors or investigating suspected abuse, and customers can enable Zero Data Retention. Customer data is held in GCP buckets in the United States. The page does not state a training policy.
- **Fireworks** does not log or store prompt or generation data for open models without explicit opt-in. With the Responses API and \`store=True\`, conversations are kept and deleted after 30 days.
- **Cerebras**: Cerebras states that it does not retain prompt content, requests, responses or logs, and describes inference as processed in US-based data centres. This came from a help-centre article and the privacy policy via search, not read directly from a docs page.
- **Vertex AI**: Gemini on Vertex caches customer data in memory by default and deletes it within 24 hours. Strict zero data retention needs caching disabled per project and an abuse-monitoring exception requested from Google.
- **OpenRouter** does not log prompts unless you opt in, and each serving provider has its own policy. Setting \`data_collection\` to deny uses only providers that do not collect user data, and \`zdr\` to true restricts routing to endpoints with a Zero Data Retention policy.
- **Claude Code** sends the transcript with \`/feedback\`, \`/bug\` and \`/share\`, retained for 5 years.

### Not confirmed

- **MiniMax**: Search results say API data is stored in a United States data centre, and a third-party analysis says the API terms let MiniMax use input and generated content to improve its services, with no opt-out. We could not read the privacy and terms pages.
- **Hugging Face Inference Providers**: the pages we read describe billing and routing but not a single retention or training policy, so the policy of whichever provider serves the request applies.
- **Ollama cloud**: Ollama says it processes cloud prompts and responses to answer requests and does not use them to train models; retention periods and hosting regions are not stated on the pages we read.
- **Gemini CLI**: the CLI page does not itself say whether prompts are used for training; it points to separate notices by sign-in route.
- **GitHub Copilot CLI**: the responsible use page does not state retention periods or training use for GitHub-hosted models. With a bring-your-own model provider, prompts go directly to that provider and not through GitHub.
- **Qwen Code**: prompts go to whichever provider you configure; a separate Terms of Service and Privacy Notice were not read in full.

### What NVX Ancile does about it

- It does not show a training or retention badge on keys today. Planned: a data-policy line on each key card.
- For OpenRouter, "Do not allow data collection" sets \`data_collection\` to deny on every preset, and the Advanced preset can send \`zdr\`. Both can shrink the list of models that can answer.
- Local models and notebook scopes keep data on this computer. A private notebook can be limited to models that run locally.
- Do not call a free model private on the strength of this article. Check the vendor's own page, linked below.`,
    },
    {
      id: 'caching-by-provider',
      title: 'Prompt caching by provider',
      summary: 'Minimum length, lifetime, price and how to see a hit, for each vendor that caches.',
      keywords:
        'prompt caching cache hit cached tokens cache write cache read discount TTL cheaper cost savings minimum tokens cache_control prompt_cache_key why is my cache not working too short to cache Anthropic OpenAI Gemini DeepSeek Kimi Qwen Z.ai MiniMax Groq Fireworks Cerebras OpenRouter',
      checked: PROVIDERS_CHECKED,
      sources: [
        {
          title: 'Prompt caching',
          url: 'https://platform.claude.com/docs/en/build-with-claude/prompt-caching',
        },
        { title: 'Claude API rate limits', url: 'https://platform.claude.com/docs/en/api/rate-limits' },
        {
          title: 'OpenAI prompt caching',
          url: 'https://developers.openai.com/api/docs/guides/prompt-caching',
        },
        { title: 'Gemini context caching', url: 'https://ai.google.dev/gemini-api/docs/caching' },
        { title: 'Gemini API pricing', url: 'https://ai.google.dev/gemini-api/docs/pricing' },
        {
          title: 'xAI prompt caching',
          url: 'https://docs.x.ai/developers/advanced-api-usage/prompt-caching/usage-and-pricing',
        },
        {
          title: 'Mistral prompt caching',
          url: 'https://docs.mistral.ai/studio-api/conversations/advanced/prompt-caching',
        },
        {
          title: 'How Cohere pricing works',
          url: 'https://docs.cohere.com/docs/how-does-cohere-pricing-work',
        },
        { title: 'Perplexity API pricing', url: 'https://docs.perplexity.ai/docs/getting-started/pricing' },
        {
          title: 'Perplexity rate limits and usage tiers',
          url: 'https://docs.perplexity.ai/docs/admin/rate-limits-usage-tiers',
        },
        { title: 'DeepSeek context caching', url: 'https://api-docs.deepseek.com/guides/kv_cache' },
        { title: 'DeepSeek models and pricing', url: 'https://api-docs.deepseek.com/quick_start/pricing' },
        { title: 'Kimi model pricing', url: 'https://platform.kimi.ai/docs/pricing/chat' },
        {
          title: 'MiniMax prompt caching',
          url: 'https://platform.minimax.io/docs/api-reference/text-prompt-caching.md',
        },
        {
          title: 'MiniMax pay-as-you-go pricing',
          url: 'https://platform.minimax.io/docs/guides/pricing-paygo.md',
        },
        { title: 'Model Studio context cache', url: 'https://help.aliyun.com/en/model-studio/context-cache' },
        { title: 'Z.ai context caching', url: 'https://docs.z.ai/guides/capabilities/cache' },
        { title: 'Z.ai pricing', url: 'https://docs.z.ai/guides/overview/pricing' },
        {
          title: 'OpenRouter prompt caching',
          url: 'https://openrouter.ai/docs/guides/best-practices/prompt-caching',
        },
        {
          title: 'OpenRouter: prompt caching and sticky routing',
          url: 'https://openrouter.ai/blog/tutorials/prompt-caching-sticky-routing/',
        },
        { title: 'Groq prompt caching', url: 'https://console.groq.com/docs/prompt-caching' },
        { title: 'Together docs (no caching page found)', url: 'https://docs.together.ai/docs/rate-limits' },
        { title: 'Fireworks prompt caching', url: 'https://docs.fireworks.ai/guides/prompt-caching' },
        {
          title: 'Cerebras prompt caching',
          url: 'https://inference-docs.cerebras.ai/capabilities/prompt-caching',
        },
        { title: 'Cerebras rate limits', url: 'https://inference-docs.cerebras.ai/support/rate-limits' },
      ],
      unconfirmed: [
        'no official page on prompt caching, discounts or TTL could be fetched, so do not assume automatic caching or a discount.',
        'The pricing pages we read do not mention prompt caching for Cohere, so do not assume any cached-token discount.',
        'The official pricing and rate limit pages do not describe prompt caching for the Perplexity API either.',
      ],
      body: `Caching means a provider reuses the start of a prompt it has already read, which is faster and often cheaper. The rules differ so much by vendor that one setting cannot cover them. A prompt shorter than the minimum is simply not cached, and most vendors return no error when that happens.

### Anthropic

- Minimums range from 512 to 4,096 tokens depending on the model (for example 4,096 for Opus 4.5/4.6 and Haiku 4.5, 1,024 for Sonnet 4.5/4.6, 512 for the newest generation). Shorter prompts are processed without caching and no error is returned.
- The default TTL is 5 minutes, refreshed free on reuse, or 1 hour at 2x base input price. Writes cost 1.25x (5 minutes) and reads cost 0.1x base input, or less on some newer models.
- Hits show as \`cache_read_input_tokens\`, writes as \`cache_creation_input_tokens\`, and \`input_tokens\` counts only what follows the last breakpoint.
- For most models only uncached input and cache-creation tokens count toward the input tokens per minute limit. Haiku 3.5 is the stated exception and counts cache reads too.

### OpenAI

On GPT-5.6 and later the minimum is 1,024 visible input tokens, caching can be implicit or explicit via \`prompt_cache_breakpoint\`, the TTL option is 30m, reads cost 0.1x and cache writes cost 1.25x. On earlier models caching is implicit only, with \`in_memory\` or \`24h\` retention and no cache-write charge. Hits appear in \`usage.input_tokens_details.cached_tokens\`.

### Google Gemini

Implicit caching is the default and needs no setup. The documented minimum is 4,096 tokens for the newest models and 2,048 for Gemini 2.5 Flash and Pro. Cached input for one Flash model is about 90% cheaper, and explicit cache storage is charged per million tokens per hour. Cache hits are reported in the response usage metadata.

### xAI, Mistral, DeepSeek

- **xAI**: requests that share an identical start are cached automatically. Setting the \`x-grok-conv-id\` header (or \`prompt_cache_key\`) helps keep hits. \`cached_tokens\` of 0 means a miss. Minimum length and TTL are not documented.
- **Mistral**: set \`prompt_cache_key\` on requests that share a prefix. Cached prompt tokens are billed at 10% of the input price, caching works in 64-token blocks and no TTL is documented. The key raises the chance of a hit but does not guarantee one.
- **DeepSeek**: caching is on by default and matches repeated prefixes only, so "A + C" gets no hit from "A + B". Unused cache is cleared "usually within a few hours to a few days". Hits are in \`prompt_cache_hit_tokens\` and \`prompt_cache_miss_tokens\`, not OpenAI's field names. The guide gives no minimum cache size.

### Kimi, Qwen, Z.ai, MiniMax

- **Kimi**: automatic, with 5-minute and 1-hour TTL tiers, and each hit refreshes the entry. On K2 models there is no write charge. On K3 models a cache write costs $3.00 to $6.00 per million tokens depending on the TTL chosen, against $0.30 for a cached read.
- **Qwen (Alibaba)**: implicit cache is automatic, cannot be disabled and bills cached tokens at about 20% of input price. Explicit cache has a 5-minute TTL that resets on hit, a 1,024-token minimum, 125% creation cost and 10% hit cost.
- **Z.ai**: implicit, detected with \`usage.prompt_tokens_details.cached_tokens\`. The caching guide says cached tokens bill at about 50% of standard, and cache storage is "Limited-time Free". TTL is not stated.
- **MiniMax**: automatic, for requests with 512 or more input tokens. Detect hits with \`usage.cache_read_input_tokens\` (Anthropic format) or \`usage.prompt_tokens_details.cached_tokens\` (OpenAI format). The pricing page does not state cache-write cost or TTL.

### Hosts

- **Groq**: caching is supported only on openai/gpt-oss-20b, openai/gpt-oss-120b and openai/gpt-oss-safeguard-20b. Cached input tokens get a 50% discount, and entries expire after 2 hours unused.
- **Fireworks**: caching is enabled for all models and deployments. On serverless the default discount for cached tokens is 50%, varying by model. Sending a \`user\` field or \`x-session-affinity\` header helps requests land on the same replica.
- **Cerebras**: automatic, with a guaranteed 5 minute TTL (up to an hour under light load), in 128-token blocks. Cached tokens are billed at the normal input rate, so there is no discount. They count towards your total TPM limit but not the uncached one.
- **Together**: no official page on prompt caching, discounts or TTL could be fetched, so do not assume automatic caching or a discount.
- **OpenRouter**: OpenAI, DeepSeek, Gemini 2.5+, Groq, Moonshot and Grok cache automatically. Anthropic models need a \`cache_control\` field with at most four explicit breakpoints. After a cache hit OpenRouter routes later requests to the same provider; passing \`session_id\` starts that on the first successful request.

### No caching documented

The pricing pages we read do not mention prompt caching for Cohere, so do not assume any cached-token discount. The official pricing and rate limit pages do not describe prompt caching for the Perplexity API either.

### What NVX Ancile does about it

- Every turn's request starts with the previous turn's exact bytes, with what varies placed last.
- It sends the right switch for each provider: up to four \`cache_control\` markers for Anthropic (5 minute lifetime, skipped when the prefix is under the model's minimum), \`prompt_cache_key\` for OpenAI and Mistral, \`x-grok-conv-id\` for xAI, \`x-session-affinity\` for Fireworks and Cloudflare, and \`session_id\` for OpenRouter.
- It reads cache hits from each provider's own usage field, including DeepSeek's two field names, and shows which models have the thread cached.
- Cerebras caching is marked as speed, not price: no saving is shown.
- Anthropic's 1-hour option, OpenAI's 30m option and Kimi's TTL option are planned (CA11).`,
    },
    {
      id: 'regions-endpoints',
      title: 'Regions and endpoints',
      summary: 'Where each vendor runs, which keys only work in one region, and what a region changes.',
      keywords:
        'region endpoint China international Singapore Beijing Virginia data residency EU US-only wrong region key base URL global mainland data location where is my data processed Moonshot Kimi MiniMax Z.ai BigModel Qwen DashScope Mistral EU',
      checked: PROVIDERS_CHECKED,
      sources: [
        {
          title: 'Data residency',
          url: 'https://platform.claude.com/docs/en/build-with-claude/data-residency',
        },
        { title: 'OpenAI data controls', url: 'https://developers.openai.com/api/docs/guides/your-data' },
        {
          title: 'Vertex AI zero data retention',
          url: 'https://docs.cloud.google.com/vertex-ai/generative-ai/docs/vertex-ai-zero-data-retention',
        },
        {
          title: 'Does Mistral use my data to train models',
          url: 'https://help.mistral.ai/en/articles/347617-do-you-use-my-user-data-to-train-your-artificial-intelligence-models',
        },
        { title: 'DeepSeek API docs: quick start', url: 'https://api-docs.deepseek.com/' },
        {
          title: 'Kimi Code support on the API platform',
          url: 'https://platform.kimi.ai/docs/guide/kimi-code-support',
        },
        { title: 'Kimi API overview', url: 'https://platform.kimi.ai/docs/api/overview' },
        { title: 'MiniMax CLI reference', url: 'https://platform.minimax.io/docs/m-plan/minimax-cli' },
        { title: 'MiniMax M Plan FAQ', url: 'https://platform.minimax.io/docs/token-plan/faq.md' },
        {
          title: 'Model Studio regions and endpoints',
          url: 'https://help.aliyun.com/en/model-studio/regions',
        },
        {
          title: 'What is Model Studio',
          url: 'https://help.aliyun.com/en/model-studio/what-is-model-studio',
        },
        { title: 'Token Plan overview', url: 'https://help.aliyun.com/en/model-studio/token-plan-overview' },
        {
          title: 'Token Plan Personal Edition',
          url: 'https://help.aliyun.com/en/model-studio/token-plan-personal-overview',
        },
        { title: 'Z.ai API introduction', url: 'https://docs.z.ai/api-reference/introduction' },
        { title: 'BigModel API introduction (Chinese)', url: 'https://docs.bigmodel.cn/cn/api/introduction' },
        {
          title: 'Z.ai privacy policy and data processing addendum',
          url: 'https://docs.z.ai/legal-agreement/privacy-policy.md',
        },
        {
          title: 'TechNode: Zhipu open sources ZCode after data dispute',
          url: 'https://technode.com/2026/09/21/zhipu-open-sources-zcode-after-data-dispute-and-plans-no-retention-controls-for-maas/',
        },
        { title: 'Groq your data', url: 'https://console.groq.com/docs/your-data' },
        {
          title: 'Does Cerebras retain my data',
          url: 'https://cerebras-inference.help.usepylon.com/articles/1811589793-does-cerebras-retain-my-data',
        },
        { title: 'Cerebras privacy policy', url: 'https://www.cerebras.ai/privacy-policy' },
        { title: 'OpenCode Zen', url: 'https://opencode.ai/docs/zen/' },
      ],
      unconfirmed: [
        'Moonshot runs a global console and endpoint (api.moonshot.ai/v1) and a China console and endpoint (api.moonshot.cn/v1). Kimi Code CLI states "The selected platform must match the site where the API Key was created, or API Key validation will fail." The non-interchangeability of the two API consoles comes from third-party docs only.',
        'the CLI says it "detects the service region from your key" and region can be set to cn or global. Third-party sources list api.minimax.io for global and api.minimaxi.com for China; the official pages we reviewed name only api.minimax.io.',
        'secondary sources say the API runs on EU infrastructure by default, that some features may involve subprocessors outside the EU, and that zero data retention can be activated. We could not confirm these on an official page.',
        'search results describe inference as processed in US-based data centres.',
      ],
      body: `Some vendors run one global endpoint. Others run separate services for China and everywhere else, with separate keys. A key made in one region usually fails in the other, and the error often looks like a bad key.

### Keys that only work in one region

- **Kimi (Moonshot)**: Moonshot runs a global console and endpoint (api.moonshot.ai/v1) and a China console and endpoint (api.moonshot.cn/v1). Kimi Code CLI states "The selected platform must match the site where the API Key was created, or API Key validation will fail." The non-interchangeability of the two API consoles comes from third-party docs only.
- **MiniMax**: the CLI says it "detects the service region from your key" and region can be set to cn or global. Third-party sources list api.minimax.io for global and api.minimaxi.com for China; the official pages we reviewed name only api.minimax.io.
- **Z.ai and BigModel**: Z.ai serves overseas users at api.z.ai and BigModel serves the mainland at open.bigmodel.cn. Credentials are per platform.
- **Alibaba Model Studio**: region decides where request data is stored; service deployment scope decides where inference runs, and the two are independent. Regions are Beijing, Singapore, Virginia, Frankfurt, Hong Kong and Tokyo. API keys are region-specific and "cannot be used across regions", and each region has different models, features and pricing. The legacy DashScope endpoint is listed as deprecating after September 2026.
- **Alibaba Token Plan** is available only in the China (Beijing) region, so it is a mainland China product.

### One global endpoint

- **DeepSeek**: the API base URL is https://api.deepseek.com. The docs describe no regional endpoints and no region parameter. Price varies by UTC time, not by region. Your prompts are stored in the People's Republic of China, per the privacy policy.
- **Mistral**: secondary sources say the API runs on EU infrastructure by default, that some features may involve subprocessors outside the EU, and that zero data retention can be activated. We could not confirm these on an official page.

### Regions you can pay to choose

- **Anthropic**: the \`inference_geo\` parameter accepts "global" (default) or "us". US-only is priced at 1.1x across all token categories on Claude 4.6 and later, and older models return a 400 if the parameter is sent.
- **OpenAI**: regional storage is offered in ten locations: US, EU, Australia, Canada, Japan, India, Singapore, South Korea, UK and UAE. Eligible models released on or after 5 March 2026 carry a 10% price uplift.

### Where processing happens

- **Z.ai**: customer data is "generally processed in Singapore".
- **Groq**: customer data is held in GCP buckets in the United States.
- **OpenCode Zen**: all Zen models are hosted in the US and EU.
- **Cerebras**: search results describe inference as processed in US-based data centres.

### What NVX Ancile does about it

- It stores a region with the key for Moonshot (International or China), MiniMax (Global or China), Qwen (Singapore, Beijing or US Virginia) and Z.ai (International or China), and picks the base URL from it. Qwen workspace hosts and the other Alibaba regions need a custom base URL on the model.
- When a provider answers that a key belongs to another region, the error names the other regions, such as "Try China (Beijing)".
- There is no region picker for DeepSeek, which has one endpoint.
- An Anthropic US-only toggle and an OpenAI data-residency setting are planned, not built.`,
    },
    {
      id: 'errors-alike',
      title: 'Errors that look alike',
      summary:
        'Out of money, out of plan, rate limited, overloaded or a wrong key: how to tell them apart and what to do.',
      keywords:
        'error 429 402 400 403 out of credit insufficient balance rate limit too many requests overloaded 529 503 wrong key arrearage insufficient_quota credit balance is too low quota exceeded limit reached plan exhausted what does this error mean why does retry not work',
      checked: PROVIDERS_CHECKED,
      sources: [
        { title: 'Claude API rate limits', url: 'https://platform.claude.com/docs/en/api/rate-limits' },
        { title: 'Claude API errors', url: 'https://platform.claude.com/docs/en/api/errors' },
        {
          title: 'API credits for Max and Team plans',
          url: 'https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers',
        },
        { title: 'OpenAI rate limits', url: 'https://developers.openai.com/api/docs/guides/rate-limits' },
        {
          title: 'Troubleshooting API rate limits and 429 errors',
          url: 'https://help.openai.com/en/articles/5955604-troubleshooting-api-rate-limits-and-429-errors',
        },
        { title: 'Gemini API errors', url: 'https://ai.google.dev/gemini-api/docs/api-errors' },
        { title: 'Gemini API rate limits', url: 'https://ai.google.dev/gemini-api/docs/rate-limits' },
        { title: 'DeepSeek error codes', url: 'https://api-docs.deepseek.com/quick_start/error_codes' },
        { title: 'Kimi API error codes', url: 'https://platform.kimi.ai/docs/api/errors' },
        { title: 'MiniMax error codes', url: 'https://platform.minimax.io/docs/api-reference/errorcode.md' },
        { title: 'Model Studio error codes', url: 'https://help.aliyun.com/en/model-studio/error-code' },
        { title: 'Coding Plan FAQ', url: 'https://help.aliyun.com/en/model-studio/coding-plan-faq' },
        { title: 'GLM Coding Plan FAQ', url: 'https://docs.z.ai/devpack/faq' },
        { title: 'Z.ai API error codes', url: 'https://docs.z.ai/api-reference/api-code' },
        { title: 'OpenRouter API limits', url: 'https://openrouter.ai/docs/api-reference/limits' },
        { title: 'Groq rate limits', url: 'https://console.groq.com/docs/rate-limits' },
        {
          title: 'Fireworks rate limits and quotas',
          url: 'https://docs.fireworks.ai/guides/quotas_usage/rate-limits',
        },
      ],
      unconfirmed: [
        'A fast traffic jump returns 429 `rate_limit_error` with code "slow_down". A busy model returns 503 `service_unavailable_error` with code "server_is_overloaded". Out-of-credit errors use the code `insufficient_quota` (HTTP 429) while per-minute limits use `rate_limit_exceeded`; retrying the first never helps.',
      ],
      body: `The same HTTP number can mean different things at different vendors. A 429 is sometimes "wait a moment" and sometimes "you have no money". Retrying the second kind never helps. This article lists the shapes that look alike, by vendor.

### The rule of thumb

Read the error code in the body, not just the HTTP status. Out of money and out of plan are fixed by paying or by waiting for a reset. A rate limit is fixed by waiting seconds. An overload is fixed by trying again.

### Anthropic

- A tier spend cap returns HTTP 429 \`rate_limit_error\` with \`details.error_code\` "enforced_spend_limit_reached" and no \`retry-after\` header, so retrying keeps failing.
- A spend limit you set returns HTTP 400 \`invalid_request_error\` starting "You have reached your specified API usage limits".
- Empty credit returns "Your credit balance is too low to access the Anthropic API", and billing problems use HTTP 402 \`billing_error\`.
- HTTP 529 \`overloaded_error\` means the API is busy for everyone and can be retried with backoff. Sharp usage jumps can also cause a 429 from acceleration limits, which is cured by ramping up gradually. Errors can also arrive mid-stream after a 200 response.

### OpenAI

A fast traffic jump returns 429 \`rate_limit_error\` with code "slow_down". A busy model returns 503 \`service_unavailable_error\` with code "server_is_overloaded". Out-of-credit errors use the code \`insufficient_quota\` (HTTP 429) while per-minute limits use \`rate_limit_exceeded\`; retrying the first never helps.

### Google Gemini

The error reference lists \`rate_limit_exceeded\` (per-minute or per-second limit, wait and retry) and \`quota_exceeded\` (daily quota, wait for reset or ask for more) as separate 429s. A 400 \`failed_precondition\` can mean a prerequisite such as billing is disabled. Older docs and SDKs use the status name \`RESOURCE_EXHAUSTED\` for the 429s.

### DeepSeek

402 means "You have run out of balance". 429 means "You are sending requests too quickly, or have exceeded a concurrency or QPS limit". 503 is server overload and 500 is a server fault; both should be retried. 401 is a wrong key.

### Kimi (Moonshot)

Both are 429. \`exceeded_current_quota_error\` covers "Account balance is insufficient" or "Token quota is insufficient". \`rate_limit_reached_error\` covers concurrency, RPM, TPM and TPD limits. The error type, not the status, tells you whether to retry. Long requests can end in 504 after 900 seconds with no response.

### MiniMax

Errors use numeric codes. 1008 is Insufficient Balance. 1002 is Rate Limit and 1039 is Token Limit; both say to retry later. 2056 is the plan window being used up, which means wait for the next 5-hour window, not top up. 1004 and 2049 are authentication errors.

### Alibaba Model Studio

Arrearage (400) is "Access denied, please make sure your account is in good standing". AllocationQuota.FreeTierOnly (403) means the free tier is spent and free-only mode is on. Throttling.RateQuota and Throttling.BurstRate (429) are rate limits. InvalidApiKey (401) commonly means a key and base URL region mismatch.

### Z.ai

1113 is no balance or resource package; 1305 is service overload; 1302 is rate limit; 1310 is a weekly or monthly limit; 1316 and 1317 are 5-hour and 7-day caps; 1311 means the subscription does not include that model. All are HTTP 429. 1001 and 401 are authentication failures.

The FAQ says using unsupported tools triggers error 1113 or unauthorised balance deductions. So a balance error may really mean the plan key is being used outside its permitted scope.

### OpenRouter, Groq, Fireworks

- **OpenRouter**: if your credit balance drops below zero you may see 402 errors, including on free models. The 402 body can carry a reason such as \`in_flight_budget_exhausted\` (transient, retry later) or \`weight_exceeds_budget\` (lower \`max_tokens\` or the prompt, or add credits). Errors that happen after streaming has begun arrive as an event with \`finish_reason\` set to error.
- **Groq**: \`x-ratelimit-limit-requests\` is the daily request limit, while \`x-ratelimit-limit-tokens\` is the per-minute token limit. A 429 may be a daily cap rather than a per-minute one.
- **Fireworks**: an HTTP 429 on deployment endpoints typically means the deployment is saturated rather than that you hit a TPM tier cap.

### What NVX Ancile does about it

- It reads each provider's body through that provider's own rule table and sorts the failure into one of: bad key, out of credit, plan credit used up, rate limited, overloaded, wrong region, model not allowed for this key, or a server fault.
- A key is only called bad on a 401 or 403 whose body sounds like authentication. Throttling and empty credit are never called a bad key.
- Out of credit, a wrong key, a wrong region and a model the key cannot use are not retried. A rate limit, an overload and a server fault are retried with backoff, honouring \`Retry-After\` up to 60 seconds.
- Each failure shows as an error with a title and a hint, such as "Your plan's monthly API credit is used up." The codes are documented in docs/errors.md.
- These codes are never retried, and their messages say what they really mean: MiniMax 2056 and Z.ai 1310, 1316 and 1317 say to wait for the plan's window, and Z.ai 1113 says it can also mean a Coding Plan key used from a tool the plan does not cover. Anthropic's tier spend cap (429, \`enforced_spend_limit_reached\`) is not mistaken for a rate limit.`,
    },
    {
      id: 'prov-anthropic',
      title: 'Anthropic (Claude)',
      summary:
        'Subscription, included monthly credit and pay as you go; limits, errors, caching, data and regions.',
      keywords:
        'Anthropic Claude Pro Max Team Console API key included credit monthly credit credit balance too low rate limit 529 overloaded does Anthropic train on my data free tier out of credit prompt caching US-only inference_geo ANTHROPIC_API_KEY',
      checked: PROVIDERS_CHECKED,
      sources: [
        {
          title: 'Using Claude Code with your Pro or Max plan',
          url: 'https://support.claude.com/en/articles/11145838-using-claude-code-with-your-pro-or-max-plan',
        },
        {
          title: 'API credits for Max and Team plans',
          url: 'https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers',
        },
        { title: 'Claude API rate limits', url: 'https://platform.claude.com/docs/en/api/rate-limits' },
        { title: 'Claude API errors', url: 'https://platform.claude.com/docs/en/api/errors' },
        {
          title: 'Prompt caching',
          url: 'https://platform.claude.com/docs/en/build-with-claude/prompt-caching',
        },
        { title: 'Claude Code data usage', url: 'https://code.claude.com/docs/en/data-usage' },
        {
          title: 'Data residency',
          url: 'https://platform.claude.com/docs/en/build-with-claude/data-residency',
        },
        {
          title: 'Monthly API credits for Max and Team plans',
          url: 'https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-and-team-plans',
        },
      ],
      body: `Claude can be paid for in three separate ways. NVX Ancile calls them **Claude subscription**, **Included monthly credit** and **Pay as you go**, and keeps them apart.

### Three ways to pay

A Claude subscription (Pro, Max, Team) gives usage limits through the Claude Code login. Max and Team plans also include a monthly API credit that is spent by API keys in a linked Console organisation. Pay-as-you-go API credit is a third, separate balance bought in the Console. Signed in with your plan, the Agent SDK and \`claude -p\` use plan limits, not the credit.

### The included monthly credit

- Max 5x gets $100 and Max 20x gets $200 a month. Team gets $20 per Standard seat and $100 per Premium seat, pooled and capped at $500.
- Unused credit expires at the end of each billing cycle (monthly on annual plans) and does not roll over.
- Every API key and workspace in the linked Console organisation draws from one balance. Included credits are spent first, then credits you bought. Auto-reload looks only at the purchased balance, so it can top up while included credit remains.
- The credit covers the Claude API, Managed Agents, the Agent SDK and the Playground. It does not cover Claude Code or extra usage in the Claude apps. A Console organisation holding only this credit gets the message "Credit balance too low" if a Claude Code session is run against it.
- Each plan links to exactly one Console organisation, each organisation can take credit from only one plan, and you cannot change the link yourself. New subscribers can claim after 7 days. Free, Pro and Enterprise plans are not eligible.

### Limits

- Pro and Max share a five-hour session limit and a weekly limit across Claude and Claude Code together. Claude Code in IDEs counts toward the same limits. Included API credit does not change these limits.
- API limits are requests, input tokens and output tokens per minute, set per organisation by usage tier. Capacity refills continuously rather than resetting at fixed times. Responses carry \`anthropic-ratelimit-*\` headers with \`-limit\`, \`-remaining\` and \`-reset\`, plus \`retry-after\` on most 429s.
- Start, Build and Scale tiers have monthly spend caps of $500, $1,000 and $200,000 that reset at 00:00 UTC on the first of the month. A cap you set yourself is separate from the tier cap.

### If something fails

See "Errors that look alike" for the four shapes of out of money and rate limit. HTTP 529 \`overloaded_error\` is not your rate limit. Newer models reject assistant prefill, forced \`tool_choice\`, thinking "disabled" (on always-thinking models) and thinking "enabled" (on 4.7 and later) with a 400 \`invalid_request_error\`. Replayed thinking blocks must be unmodified or the request fails.

### An API key in the environment

If \`ANTHROPIC_API_KEY\` is set, Claude Code uses it instead of the Claude subscription and the usage is charged as API usage. Removing the key or logging in again restores subscription use.

### Caching, data and region

- Prompt caching has a minimum length per model and fails silently below it. See "Prompt caching by provider".
- For Free, Pro and Max (including Claude Code) data is used for training when the setting is on, with 5-year retention if allowed and 30 days if not. Team, Enterprise and API data is not used for training unless the customer opts in, with 30-day standard retention. Zero data retention is available to qualified accounts.
- The \`inference_geo\` parameter accepts "global" (default) or "us". US-only is priced at 1.1x across all token categories on Claude 4.6 and later.
- Claude Code keeps plaintext session files on disk for 30 days. See "Where your chat is saved".

### What NVX Ancile does about it

- Every Claude model is labelled by how it is paid: Plan, Key or Included credit. The three balances are never merged.
- With "Spends my included monthly credit first" on, Settings shows a meter for this cycle (spent, left, and when it renews) and a notification warns at 80%. It is NVX Ancile's own count of spend made through the key.
- When Anthropic says the credit is gone, models paid from it are skipped until the cycle ends, and nothing is retried or charged to your plan.
- \`ANTHROPIC_API_KEY\` is kept out of the environment NVX Ancile gives to Claude Code. Only the Claude Code (monthly credit) model gets your Anthropic key, in that one session. A plan session stays on the plan login.
- Settings, Usage shows your plan's limits as their own meter, apart from API spend.
- Error shapes are sorted as in "Errors that look alike". Out of credit is never retried, and 529 is.
- Cache markers are set per model and left off when the prefix is under the model's minimum. Thinking blocks are sent back unmodified.
- Anthropic's "Credit balance too low" for the monthly credit key is shown as "Your plan's monthly API credit is used up." NVX Ancile's Claude Code (monthly credit) model runs through the Agent SDK, which the credit covers. If a Claude Code session on that key is refused, switch to the plain Claude Code model.
- The Claude Code commands NVX Ancile runs (sign-in status, MCP) never see a stray \`ANTHROPIC_API_KEY\` or auth token from your environment, so they always use your own login.
- Planned, not built: reading the \`anthropic-ratelimit-*\` headers to show headroom, the US-only toggle, the data-policy line on a key card, and a warning when your own shell has \`ANTHROPIC_API_KEY\` set for the Claude Code you run yourself.`,
    },
    {
      id: 'prov-openai',
      title: 'OpenAI',
      summary: 'ChatGPT plans against API keys, Codex limits, 429 shapes, caching, data and residency.',
      keywords:
        'OpenAI ChatGPT Plus Pro API key Codex insufficient_quota rate limit 429 tier GPT does OpenAI train on my data prompt_cache_key 30 day retention zero data retention data residency out of credit',
      checked: PROVIDERS_CHECKED,
      sources: [
        { title: 'Codex pricing and plans', url: 'https://learn.chatgpt.com/docs/pricing' },
        { title: 'Codex authentication', url: 'https://learn.chatgpt.com/docs/auth' },
        {
          title: 'Sign in with ChatGPT for developers',
          url: 'https://developers.openai.com/siwc/token-sharing-open-source/sign-in',
        },
        {
          title: 'Sign in with ChatGPT terms',
          url: 'https://openai.com/policies/sign-in-with-chatgpt-terms/',
        },
        { title: 'OpenAI rate limits', url: 'https://developers.openai.com/api/docs/guides/rate-limits' },
        {
          title: 'Troubleshooting API rate limits and 429 errors',
          url: 'https://help.openai.com/en/articles/5955604-troubleshooting-api-rate-limits-and-429-errors',
        },
        {
          title: 'OpenAI prompt caching',
          url: 'https://developers.openai.com/api/docs/guides/prompt-caching',
        },
        { title: 'OpenAI data controls', url: 'https://developers.openai.com/api/docs/guides/your-data' },
      ],
      unconfirmed: [
        'The terms page reportedly also bars using the plan for general-purpose API access to other tools, which we could not read directly.',
        'A fast traffic jump returns 429 `rate_limit_error` with code "slow_down". A busy model returns 503 with code "server_is_overloaded". Out-of-credit errors use the code `insufficient_quota` (HTTP 429) while per-minute limits use `rate_limit_exceeded`; retrying the first never helps.',
      ],
      body: `OpenAI sells two separate things: a ChatGPT plan, and an API account on the OpenAI Platform.

### Plan or key

Signing in to Codex with ChatGPT uses your plan allowance and follows your workspace permissions. Signing in with an API key bills your OpenAI Platform account at standard API rates. API key use cannot reach cloud features such as GitHub reviews, Slack and automatic pull requests.

On Plus and standard Business plans local messages and cloud tasks share one allowance in a five-hour window, with weekly limits on top. Pro plans currently have no five-hour limit, and extra credits can be bought after the allowance is used.

### Sign in with ChatGPT

OpenAI's developer docs say that when an app uses ChatGPT tokens through Sign in with ChatGPT, "the user's ChatGPT plan usage limits are consumed", not the developer's API quota. The terms page reportedly also bars using the plan for general-purpose API access to other tools, which we could not read directly.

### API limits and errors

- Tiers are Free, Build ($5 of credit purchased), Launch ($100) and Grow ($500), with monthly caps of $100, $500, $5,000 and $200,000.
- Headers \`x-ratelimit-limit\`, \`-remaining\` and \`-reset\` for requests and tokens report status. A value like 6m0s is the time until the limit returns to its initial state.
- A fast traffic jump returns 429 \`rate_limit_error\` with code "slow_down". A busy model returns 503 with code "server_is_overloaded". Out-of-credit errors use the code \`insufficient_quota\` (HTTP 429) while per-minute limits use \`rate_limit_exceeded\`; retrying the first never helps.

### Caching

On GPT-5.6 and later the minimum is 1,024 visible input tokens, caching can be implicit or explicit via \`prompt_cache_breakpoint\`, the TTL option is 30m, reads cost 0.1x and cache writes cost 1.25x. On earlier models caching is implicit only, with \`in_memory\` or \`24h\` retention and no cache-write charge. Hits appear in \`usage.input_tokens_details.cached_tokens\`.

### Data and residency

- Abuse monitoring logs are kept for up to 30 days unless the law requires longer, and API data is not used for training unless you opt in. Zero data retention needs prior OpenAI approval, and then the store parameter is always treated as false.
- Regional storage is offered in ten locations. Eligible models released on or after 5 March 2026 carry a 10% price uplift.
- Codex keeps login tokens in \`~/.codex/auth.json\` or the OS keyring. OpenAI says to treat \`auth.json\` like a password.

### What NVX Ancile does about it

- OpenAI is used with an API key only. A ChatGPT login is not an API credential, so there is no ChatGPT route. See "Using your subscriptions in NVX Ancile".
- \`insufficient_quota\` and the other out-of-credit codes are read as out of credit and not retried. Other 429s are rate limits and are retried with backoff. A 503 \`server_is_overloaded\` is retried.
- A \`prompt_cache_key\` is sent on every call so caching works from the first turn. OpenAI's 30m option and explicit breakpoints are planned (CA11).
- Cache hits are read from the usage fields. Reading the \`x-ratelimit-*\` headers, showing your tier, and a data-residency setting are planned, not built.
- Codex is not an engine in NVX Ancile yet, and NVX Ancile never reads \`~/.codex\`.`,
    },
    {
      id: 'prov-google',
      title: 'Google (Gemini)',
      summary:
        'Free tier, prepay and postpay, per-project limits, free-tier data use, caching and Gemini CLI.',
      keywords:
        'Google Gemini API AI Studio free tier prepay postpay billing project quota midnight Pacific Gemini CLI Code Assist Vertex AI does Google train on my data human review RESOURCE_EXHAUSTED rate limit out of credit Google AI Pro Ultra',
      checked: PROVIDERS_CHECKED,
      sources: [
        { title: 'Gemini API billing', url: 'https://ai.google.dev/gemini-api/docs/billing' },
        {
          title: 'Google AI plans and the Gemini API',
          url: 'https://ai.google.dev/gemini-api/docs/google-ai-plans',
        },
        { title: 'Gemini API additional terms', url: 'https://ai.google.dev/gemini-api/terms' },
        { title: 'Gemini API pricing', url: 'https://ai.google.dev/gemini-api/docs/pricing' },
        { title: 'Gemini context caching', url: 'https://ai.google.dev/gemini-api/docs/caching' },
        { title: 'Gemini API rate limits', url: 'https://ai.google.dev/gemini-api/docs/rate-limits' },
        { title: 'Gemini API errors', url: 'https://ai.google.dev/gemini-api/docs/api-errors' },
        { title: 'Using Gemini API keys', url: 'https://ai.google.dev/gemini-api/docs/api-key' },
        { title: 'Gemini models', url: 'https://ai.google.dev/gemini-api/docs/models' },
        {
          title: 'Gemini CLI quotas and pricing',
          url: 'https://geminicli.com/docs/resources/quota-and-pricing/',
        },
        { title: 'Gemini CLI terms and privacy', url: 'https://geminicli.com/docs/resources/tos-privacy/' },
        { title: 'Gemini CLI authentication', url: 'https://geminicli.com/docs/get-started/authentication/' },
        {
          title: 'Vertex AI zero data retention',
          url: 'https://docs.cloud.google.com/vertex-ai/generative-ai/docs/vertex-ai-zero-data-retention',
        },
      ],
      unconfirmed: [
        'Secondary reports say Pro includes $10 of monthly credit and Ultra tiers $40 or $100, but we could not confirm the amounts on an official page.',
        'The CLI reads settings and keys from `~/.gemini` and caches the Google sign-in locally, though the exact credential file path was not stated.',
      ],
      body: `The Gemini API bills by Google Cloud project, not by key, and a free tier sits beside the paid ones.

### Billing states

New projects start on the free tier. Upgrading means linking a billing account and prepaying at least $5, or being on postpay where you are charged monthly or at an automatic spend cap. On prepay, when the balance reaches $0 every API key in the project stops at once.

API keys take the tier and billing status of their Google Cloud project, and all keys in a project count toward its spend cap. Tier spend caps listed are $250, $2,000 and $20,000 to $100,000 a month for tiers 1 to 3.

### Google AI Pro and Ultra

Google says AI plan benefits apply only in the Google AI Studio web interface, and direct Gemini API use with keys or external apps is billed separately. Subscribers with a Cloud project and billing can receive monthly Google Developer Program Cloud credits that include the Gemini API. Secondary reports say Pro includes $10 of monthly credit and Ultra tiers $40 or $100, but we could not confirm the amounts on an official page.

### Limits

Limits are requests per minute, input tokens per minute and requests per day, and exceeding any one triggers an error. They apply to the project, not the key. Daily quotas reset at midnight Pacific time. Tiers move up by billing and spend: Tier 1 on linking billing, Tier 2 after $100 spent and 3 days, Tier 3 after $1,000 and 30 days.

A 429 means either a per-minute limit (\`rate_limit_exceeded\`, wait and retry) or an exhausted daily quota (\`quota_exceeded\`, wait for reset). A 400 \`failed_precondition\` can mean a prerequisite such as billing is disabled.

The pricing page says the newest model is not available on the free tier while older Flash models are free of charge. It also lists a price increase for one Flash model from 1 January 2027.

### Your key

Keys made in Google AI Studio since 28 May 2026 are authorisation keys, not the older standard keys. Google says these are bound to a service account, and the Gemini API rejects requests from unrestricted standard keys. A new key starts with \`AQ.\` where older ones start with \`AIza\`. The key travels in the \`x-goog-api-key\` header.

Google's models page lists the exact model codes, and they change: a preview model such as \`gemini-3.1-pro-preview\` carries its status in the code, and a code Google does not list answers 404.

### Free tier and your data

For free services, Google uses submitted content and responses to improve its products, and human reviewers may read, annotate and process API input and output. For paid services Google says it does not use prompts or responses to improve its products. Both tiers log prompts for a limited period to detect misuse.

### Caching

Implicit caching is the default and needs no setup. The documented minimum is 4,096 tokens for the newest models and 2,048 for Gemini 2.5 Flash and Pro. Explicit cache storage is charged per million tokens per hour.

### Gemini CLI

- Quotas depend on how you sign in. A Google account (Code Assist) is listed at 1,000 requests a day, an unpaid API key at 250 a day on Flash only, Google AI Pro 1,500, AI Ultra 2,000, Code Assist Standard 1,500 and Enterprise 2,000. Requests are also limited per user per minute.
- Terms and privacy notices differ by sign-in type. The terms page says using third-party software to reach the services behind the CLI "is a violation of applicable terms and policies".
- The CLI reads settings and keys from \`~/.gemini\` and caches the Google sign-in locally, though the exact credential file path was not stated.

### Vertex AI

Gemini on Vertex caches customer data in memory by default and deletes it within 24 hours. Strict zero data retention needs caching disabled per project and an abuse-monitoring exception requested from Google.

### What NVX Ancile does about it

- Google is used with an API key. A Google AI Pro or Ultra subscription does not pay for it.
- A key is checked by asking Google for its model list with the key, which spends no tokens. Both \`AQ.\` and \`AIza\` keys are accepted. Models in NVX Ancile's list that Google does not offer to that key stay off, and the key is still saved.
- Cache hits are read from the response usage. A 402 (prepaid credits ran out) is read as out of credit. A 429 \`RESOURCE_EXHAUSTED\` is treated as a rate limit and retried, so a spent daily quota is retried rather than explained. Telling the two 429s apart is planned.
- Showing the project's billing state, grouping keys by project, and showing the daily reset in local time are planned, not built.
- Gemini CLI is not an engine in NVX Ancile. NVX Ancile never reads its sign-in or reuses its OAuth login.`,
    },
    {
      id: 'prov-xai',
      title: 'xAI (Grok)',
      summary: 'Prepaid credits, tiers that rise with lifetime spend, and automatic caching.',
      keywords:
        'xAI Grok SuperGrok X Premium API credits prepaid auto top-up rate limit tier cached tokens x-grok-conv-id free credit out of credit',
      checked: PROVIDERS_CHECKED,
      sources: [
        { title: 'xAI billing', url: 'https://docs.x.ai/docs/key-information/billing' },
        {
          title: 'xAI consumption and rate limits',
          url: 'https://docs.x.ai/docs/key-information/consumption-and-rate-limits',
        },
        {
          title: 'xAI prompt caching',
          url: 'https://docs.x.ai/developers/advanced-api-usage/prompt-caching/usage-and-pricing',
        },
      ],
      unconfirmed: [
        'Secondary comparison sites say no consumer Grok plan (SuperGrok, X Premium) includes API tokens and that API billing is separate. We could not read an official xAI statement to confirm it.',
        'Secondary sites mention a $25 sign-up credit and a $150 a month data-sharing credit, and some say the latter ended in May 2025. The official billing page we read does not mention either.',
      ],
      body: `xAI sells API credit that you buy before you use it.

### Paying

The standard route is to buy credits that API use draws down. Monthly invoiced billing exists but is disabled by default and needs sales. Auto top-up can be set with a trigger amount, a purchase size of at least $5 and a maximum total per month, with a warning at 80% of that maximum.

Secondary comparison sites say no consumer Grok plan (SuperGrok, X Premium) includes API tokens and that API billing is separate. We could not read an official xAI statement to confirm it. Secondary sites mention a $25 sign-up credit and a $150 a month data-sharing credit, and some say the latter ended in May 2025. The official billing page we read does not mention either.

### Limits

Limits are requests per second (derived as requests per minute divided by 48, with a minimum of 2) and tokens per minute. Tiers unlock automatically with cumulative spend since 1 January 2026 at $0, $50, $250, $1,000, $5,000 and Enterprise, and never go down. Cached prompt tokens still count toward tokens per minute, and the page does not describe rate limit headers.

### Caching

Requests that share an identical start are cached automatically and cached tokens are billed at a lower cached price. Setting the \`x-grok-conv-id\` header (or \`prompt_cache_key\`) helps keep hits. \`cached_tokens\` of 0 means a miss.

### What NVX Ancile does about it

- It sends a stable \`x-grok-conv-id\` for each conversation branch and reads \`cached_tokens\` from the usage.
- It does not rely on rate-limit headers for xAI. A 429 is a rate limit and is retried with backoff.
- A 403 saying the team has no credits is read as out of credit. That wording was observed, not documented, so it is not treated as proof of anything else.
- There is no SuperGrok login route. Use an API key.
- Showing your credit balance and a warning when auto top-up nears its cap are planned, not built.`,
    },
    {
      id: 'prov-mistral',
      title: 'Mistral',
      summary: 'Le Chat against the API, the free Experiment plan, free-plan data use and caching by key.',
      keywords:
        'Mistral Le Chat Studio Experiment plan free tier API key does Mistral train on my data prompt_cache_key EU rate limit La Plateforme Vibe',
      checked: PROVIDERS_CHECKED,
      sources: [
        {
          title: 'Activate Studio and generate an API key',
          url: 'https://docs.mistral.ai/getting-started/quickstarts/studio/activate-and-generate-api-key',
        },
        {
          title: 'Try the API for free with the Experiment plan',
          url: 'https://help.mistral.ai/en/articles/455206-how-can-i-try-the-api-for-free-with-the-experiment-plan',
        },
        {
          title: 'Does Mistral use my data to train models',
          url: 'https://help.mistral.ai/en/articles/347617-do-you-use-my-user-data-to-train-your-artificial-intelligence-models',
        },
        {
          title: 'Mistral prompt caching',
          url: 'https://docs.mistral.ai/studio-api/conversations/advanced/prompt-caching',
        },
        {
          title: 'Mistral rate limits and usage tiers',
          url: 'https://docs.mistral.ai/deployment/ai-studio/tier',
        },
      ],
      unconfirmed: [
        'Secondary pricing guides say Le Chat plans and the API are separate products with separate billing. We could not confirm this on an official Mistral page.',
        'Secondary sources add phone verification and limits of about 1 request a second and 500,000 tokens a minute, which we could not confirm on the official help page.',
        'Official pages now call the developer console Studio and the consumer apps Vibe, and old La Plateforme links redirect or 404. Documentation URLs for tiers and the Experiment plan moved, so check limits in the console rather than from memory.',
        'Secondary sources say the API runs on EU infrastructure by default and that zero data retention can be activated, which also removes the 30-day abuse monitoring window. We could not confirm these on an official page.',
      ],
      body: `Mistral's API is billed separately from its consumer apps.

### Paying

Secondary pricing guides say Le Chat plans and the API are separate products with separate billing. We could not confirm this on an official Mistral page.

The activation guide says free-mode API access is on by default with no credit card and usage and rate limits apply. Secondary sources add phone verification and limits of about 1 request a second and 500,000 tokens a minute, which we could not confirm on the official help page.

Official pages now call the developer console Studio and the consumer apps Vibe, and old La Plateforme links redirect or 404. Documentation URLs for tiers and the Experiment plan moved, so check limits in the console rather than from memory.

### Your data

Mistral's help centre says Studio Free data may be used for model improvement unless you opt out, while pay-as-you-go users keep control and can opt out any time. Using the rating buttons authorises use of that feedback regardless of plan. Enterprise customers are opted out by default.

Secondary sources say the API runs on EU infrastructure by default and that zero data retention can be activated, which also removes the 30-day abuse monitoring window. We could not confirm these on an official page.

### Caching

Set \`prompt_cache_key\` on requests that share a prefix. Cached prompt tokens are billed at 10% of the input price, caching works in 64-token blocks and \`cached_tokens\` is reported in \`usage.prompt_tokens_details\` as a multiple of 64. The key raises the chance of a hit but does not guarantee one, and no TTL is documented.

### What NVX Ancile does about it

- It asks for an API key. A Le Chat login does not work in NVX Ancile.
- It sends a stable \`prompt_cache_key\` and treats a hit as best effort.
- A free Mistral key is not marked as free in NVX Ancile today. Expect 429 under load on a free key. A warning about free-plan data use is planned.`,
    },
    {
      id: 'prov-cohere',
      title: 'Cohere',
      summary: 'Trial keys against production keys, monthly call caps, training controls and billed tokens.',
      keywords:
        'Cohere trial key production key rate limit 1000 calls month Command Rerank Embed data controls training zero data retention billed tokens free',
      checked: PROVIDERS_CHECKED,
      sources: [
        {
          title: 'How Cohere pricing works',
          url: 'https://docs.cohere.com/docs/how-does-cohere-pricing-work',
        },
        { title: 'Cohere going live', url: 'https://docs.cohere.com/docs/going-live' },
        { title: 'Cohere API keys and rate limits', url: 'https://docs.cohere.com/docs/rate-limits' },
        { title: 'Cohere enterprise data commitments', url: 'https://cohere.com/data-usage-policy' },
      ],
      unconfirmed: [
        'The pricing pages we read do not mention prompt caching. Do not assume any cached-token discount.',
      ],
      body: `Cohere gives out two kinds of key, and the free one is not for production.

### Trial and production keys

Every new user gets a free, rate-limited trial key. A production key is paid and much less limited, billed per token for generation, per search for rerank and per embedded token for embeddings. Getting one means accepting the SaaS agreement and terms, and sensitive use cases may wait up to 72 business hours for review.

The going-live page says trial keys are rate-limited and not suitable for production deployment. Secondary sources state it more plainly as no production or commercial use.

### Limits

The rate limit page lists Chat at 20 requests a minute on trial and 500 on production, Rerank at 10 and 1,000, and Embed at 2,000 inputs a minute for both. It also says trial keys, and production keys on newer Chat model variants, are limited to 1,000 API calls a month.

### Your data

Training use is controlled by a Data Controls toggle in Settings on the Cohere Platform, and secondary sources say the default is on. Logged prompts and generations are deleted after 30 days unless the law or a contract requires longer. Zero data retention is for enterprise customers who accept extra commitments.

### Caching and billed tokens

The pricing pages we read do not mention prompt caching. Do not assume any cached-token discount. Cohere bills "billed" input and output tokens, and some tokens added internally are not charged, so usage and the bill can differ from your own token count.

### What NVX Ancile does about it

- A 429 on Cohere is read as a rate limit, not as out of credit, because trial keys are rate limited.
- No cache saving is shown for Cohere.
- Telling trial keys from production keys, counting the monthly calls, and prompting you to check the Data Controls toggle when you add a key are planned, not built.`,
    },
    {
      id: 'prov-perplexity',
      title: 'Perplexity',
      summary: 'API billing apart from Pro, per-request and per-token pricing, spend tiers and data.',
      keywords:
        'Perplexity API Pro Sonar Search API Agent API pricing per request tier rate limit retry-after training zero data retention caching',
      checked: PROVIDERS_CHECKED,
      sources: [
        {
          title: 'What is Perplexity Pro',
          url: 'https://www.perplexity.ai/help-center/en/articles/10352901-what-is-perplexity-pro',
        },
        { title: 'Perplexity API pricing', url: 'https://docs.perplexity.ai/docs/getting-started/pricing' },
        {
          title: 'Perplexity rate limits and usage tiers',
          url: 'https://docs.perplexity.ai/docs/admin/rate-limits-usage-tiers',
        },
        {
          title: 'Perplexity privacy and security',
          url: 'https://docs.perplexity.ai/docs/resources/privacy-security.md',
        },
      ],
      unconfirmed: [
        'Secondary sources say Pro includes $5 a month of API credit that does not roll over, which we could not confirm on an official page.',
        'The official pricing and rate limit pages do not describe prompt caching or cached-token discounts. Search-backed calls are billed per request.',
      ],
      body: `Perplexity's API is a separate product from a Perplexity Pro subscription.

### Paying

The Pro help article describes subscriber features and says nothing about API use. The API pricing page covers projects and payment methods. Secondary sources say Pro includes $5 a month of API credit that does not roll over, which we could not confirm on an official page.

Some calls are priced per request and others per token. The Search API charges each successful \`POST /search\` request, at $5 per 1,000 requests or $1 per 1,000 with Fast Search. The Agent and Orchestrator APIs bill tokens, and the Agent API adds tool fees such as $0.0025 per web search. Some models price by input size band.

### Limits

Tiers 0 to 5 start at $0, $50, $250, $500, $1,000 and $5,000 of cumulative spend and never downgrade. Agent API requests are limited per second on a rolling one-second window, and the Search API is fixed at 50 query units a second. A 429 has \`error.type\` \`request_rate_limit_exceeded\` or \`token_rate_limit_exceeded\`, a \`Retry-After\` header, and is not billed.

### Your data

Under the API terms Perplexity does not use Customer Content to train generative AI models. Zero data retention is only for eligible customers through an account-level setting under a written agreement, so it is not automatic.

### Caching

The official pricing and rate limit pages do not describe prompt caching or cached-token discounts. Search-backed calls are billed per request.

### What NVX Ancile does about it

- It needs an API key. A Pro subscription is not counted as API credit.
- \`Retry-After\` is honoured on a 429.
- Estimating cost per call type, and telling a request limit from a token limit by \`error.type\`, are planned, not built.`,
    },
    {
      id: 'prov-deepseek',
      title: 'DeepSeek',
      summary:
        'Prepaid balance only, half-price off-peak hours in UTC, caching fields, concurrency limits and data in China.',
      keywords:
        'DeepSeek API balance off-peak peak hours half price UTC context caching prompt_cache_hit_tokens concurrency 402 out of balance data China privacy training opt out API key terms deepseek-flash',
      checked: PROVIDERS_CHECKED,
      sources: [
        { title: 'DeepSeek API docs: quick start', url: 'https://api-docs.deepseek.com/' },
        { title: 'DeepSeek models and pricing', url: 'https://api-docs.deepseek.com/quick_start/pricing' },
        { title: 'DeepSeek context caching', url: 'https://api-docs.deepseek.com/guides/kv_cache' },
        { title: 'DeepSeek rate limit', url: 'https://api-docs.deepseek.com/quick_start/rate_limit' },
        { title: 'DeepSeek error codes', url: 'https://api-docs.deepseek.com/quick_start/error_codes' },
        {
          title: 'DeepSeek privacy policy',
          url: 'https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html',
        },
        {
          title: 'DeepSeek Open Platform terms of service',
          url: 'https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html',
        },
      ],
      unconfirmed: [
        'DeepSeek publishes an HTTP API and compatible-endpoint guidance, and the docs reviewed describe no first-party coding CLI. Any CLI storing DeepSeek credentials on disk is a third-party tool.',
      ],
      body: `DeepSeek sells access by prepaid balance. The API key is the only route.

### Paying

DeepSeek sells API access by prepaid balance, and the OpenAI-compatible and Anthropic-compatible endpoints both use the same API key. There is no consumer-subscription route. The pricing and quick-start pages list no free sign-up tokens. DeepSeek publishes an HTTP API and compatible-endpoint guidance, and the docs reviewed describe no first-party coding CLI. Any CLI storing DeepSeek credentials on disk is a third-party tool.

### Off-peak prices

The pricing page says: "Off-peak rates are half of the peak rates. Peak hours are 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday, excluding Chinese public holidays." Everything else, including weekends, is off-peak. For deepseek-flash, cache-miss input is $0.30 per million tokens at peak and $0.15 off-peak.

### Caching

Caching is on by default and matches repeated prefixes only. Cache-hit input for deepseek-flash is $0.006 per million tokens at peak against $0.30 for a miss. Each response carries \`prompt_cache_hit_tokens\` and \`prompt_cache_miss_tokens\`, which are DeepSeek-specific names, not OpenAI's \`prompt_tokens_details.cached_tokens\`.

### Limits and errors

Concurrency caps are 2500 for deepseek-flash and 500 for deepseek-v4-pro, counted at account level "regardless of which API Key is used". A request counts from send until the response completes. Going over returns HTTP 429, and higher limits can be requested at no cost.

402 means "You have run out of balance". 429 means "You are sending requests too quickly, or have exceeded a concurrency or QPS limit". 503 is server overload and 500 is a server fault; both should be retried. 401 is a wrong key.

### Your data

The privacy policy says DeepSeek will "directly collect, process and store your Personal Data in People's Republic of China". It lists training and improving its models as a purpose, and says users have "the right to opt-out of using your Personal Data for training our models". The policy states no fixed retention period, only "as long as necessary". It is a general policy, not an API-specific one, so treat API prompt handling as not separately documented.

### Terms and endpoint

Section 4.2 of the Open Platform terms says you "may apply the Inputs and Outputs of the Services to a wide range of use cases, including personal use, academic research, derivative product development". Section 2.2 says: "do not share or publicly disclose your API key with others". You also may not imply an official partnership with DeepSeek.

The API base URL is https://api.deepseek.com, with an Anthropic-compatible path at /anthropic. The docs describe no regional endpoints.

### What NVX Ancile does about it

- DeepSeek has one payment kind in NVX Ancile: an API key on a prepaid balance.
- Prices follow the UTC off-peak windows. Every call is priced at the rate in force when it began, and the receipt shows the rate that applied. Chinese public holidays are also off-peak and are not modelled.
- It reads both \`prompt_cache_hit_tokens\` and \`prompt_cache_miss_tokens\`.
- A 402 is read as out of credit and is never retried. A 429 and a 503 are retried with backoff. A 401 says the key was rejected.
- There is no region picker, because there is one endpoint.
- A warning that prompts reach China, and a view of the shared concurrency pool, are planned, not built.
- NVX Ancile has nothing to import from disk for DeepSeek. Paste the key.`,
    },
    {
      id: 'prov-moonshot',
      title: 'Moonshot (Kimi)',
      summary: 'Platform keys, Kimi Code membership, tier limits, regions and the rules for membership keys.',
      keywords:
        'Kimi Moonshot Kimi Code membership Open Platform API key recharge tier rate limit 429 exceeded_current_quota_error K2 K3 cache international China region User-Agent training risk control extra usage',
      checked: PROVIDERS_CHECKED,
      sources: [
        {
          title: 'Kimi Code overview and membership guide',
          url: 'https://www.kimi.com/en/help/kimi-code/membership-guide',
        },
        {
          title: 'Kimi Code support on the API platform',
          url: 'https://platform.kimi.ai/docs/guide/kimi-code-support',
        },
        {
          title: 'Kimi Code membership benefits and limits',
          url: 'https://www.kimi.com/en/help/kimi-code/benefits',
        },
        { title: 'Kimi Open Platform rate limit tiers', url: 'https://platform.kimi.ai/docs/pricing/limits' },
        { title: 'Kimi model pricing', url: 'https://platform.kimi.ai/docs/pricing/chat' },
        { title: 'Kimi API overview', url: 'https://platform.kimi.ai/docs/api/overview' },
        { title: 'Kimi API error codes', url: 'https://platform.kimi.ai/docs/api/errors' },
        {
          title: 'Kimi API data processing and security',
          url: 'https://www.kimi.com/en/help/kimi-api/api-data-security',
        },
        {
          title: 'Kimi Open Platform privacy policy',
          url: 'https://platform.kimi.ai/docs/agreement/userprivacy',
        },
        {
          title: 'Kimi Code community guidelines',
          url: 'https://www.kimi.com/code/docs/en/kimi-code/community-guidelines.html',
        },
        {
          title: 'Kimi Code CLI data locations',
          url: 'https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/data-locations.html',
        },
      ],
      unconfirmed: [
        'A search summary of a news report says Kimi Code wrongly flagged third-party agents that imitated the Kimi CLI, and settled with the open-source community on 26 May 2026.',
        'A search summary says the Open Platform privacy policy names Singapore servers, which we could not confirm on the page.',
        'Moonshot runs a global console and endpoint and a China console and endpoint. Kimi Code CLI states "The selected platform must match the site where the API Key was created, or API Key validation will fail." The non-interchangeability of the two API consoles comes from third-party docs only.',
      ],
      body: `Kimi has two sets of keys that look alike and do not work for each other.

### Three ways to pay

There are Kimi Open Platform API keys on prepaid balance, Kimi Code membership keys from the Kimi Code console, and the consumer Kimi app. The help centre contrasts "Kimi Code Platform" (membership subscription with rate limiting) with the "Kimi Platform" (pay-as-you-go). Kimi Code keys use the base URL https://api.kimi.com/coding/v1 (OpenAI) or https://api.kimi.com/coding/ (Anthropic). Platform keys use api.moonshot.ai.

A Kimi Code membership draws on a monthly total quota shared across devices and API keys. When it runs out, members can switch on "Extra Usage", a separate pay-as-you-go balance that "does not expire and stacks across top-ups". Open Platform balance is a different wallet.

### Limits

- Kimi Code: new members have no weekly quota ("quota no longer refreshes every 7 days") but face a rolling 5-hour rate window. Legacy-plan members keep a 7-day refresh plus the 5-hour window. Every tier also shares a monthly total. The Go tier has no Kimi Code access; Plus and above do.
- Platform: you must recharge at least $1 to start. Tier0 ($1) allows 1 concurrent request, 3 RPM and 1,500,000 tokens per day; Tier1 ($10) lifts this to 15 concurrent, 100 RPM and unlimited daily tokens. Vouchers do not count towards cumulative recharge.
- The limits page says that when the system detects abnormal activity, "a risk-control rate-limiting policy is triggered. Once triggered, the restriction cannot be lifted".

### Caching

The platform "automatically caches repeated request prefixes" in 5-minute and 1-hour TTL tiers, and each hit refreshes the entry. On K2 models cached input is billed at the hit price with no write charge. On K3 models a cache write costs $3.00 to $6.00 per million tokens depending on the TTL chosen, against $0.30 for a cached read.

### Errors

\`exceeded_current_quota_error\` and \`rate_limit_reached_error\` are both HTTP 429, so the error type, not the status, tells you whether to retry. 401 types are \`invalid_authentication_error\` and \`incorrect_api_key_error\`.

### Terms for membership keys

The community guidelines say: "Don't spoof or alter client identity information", "Don't use Kimi Code for non-interactive automation", and "Don't resell your account or API access". A search summary of a news report says Kimi Code wrongly flagged third-party agents that imitated the Kimi CLI, and settled with the open-source community on 26 May 2026.

### Your data

The API data page says: "User data submitted via the API, including input content and model outputs, will not be used to train or improve Kimi models." It says data is not persistently stored for training purposes, and does not state where it is processed. The consumer Kimi app has a separate policy. A search summary says the Open Platform privacy policy names Singapore servers, which we could not confirm on the page.

### Regions

Moonshot runs a global console and endpoint and a China console and endpoint. Kimi Code CLI states "The selected platform must match the site where the API Key was created, or API Key validation will fail." The non-interchangeability of the two API consoles comes from third-party docs only.

### Kimi Code CLI

Its default directory is \`~/.kimi-code\` (\`C:\\Users\\<name>\\.kimi-code\` on Windows), overridable with \`KIMI_CODE_HOME\`. It holds config, skills, plugins, OAuth credentials, sessions and logs. Older docs mention \`~/.kimi\` and \`KIMI_SHARE_DIR\`, so older installs may differ.

### What NVX Ancile does about it

- NVX Ancile has one Moonshot provider, for Open Platform keys. Kimi Code membership keys are not a separate provider yet, and a Kimi Code key sent to api.moonshot.ai will fail.
- The region (International or China) is saved with the key and picks the base URL. A 401 on a Kimi key suggests trying the other region.
- It reads the error type. \`exceeded_current_quota_error\` is read as out of credit and not retried; \`rate_limit_reached_error\` is a rate limit and is retried with backoff.
- Kimi's cache settings are planned (CA11), because its TTL option costs extra on writes.
- NVX Ancile never copies Kimi sign-in files and never uses another tool's User-Agent.
- Showing the tier and the membership quota apart from platform balance is planned, not built.`,
    },
    {
      id: 'prov-minimax',
      title: 'MiniMax',
      summary:
        'Subscription keys and pay-as-you-go keys, 5-hour and weekly windows, numeric error codes and data.',
      keywords:
        'MiniMax M Plan Token Plan subscription key sk-cp sk-api pay as you go credit packs 2056 1008 2045 error code region global China caching training privacy mmx',
      checked: PROVIDERS_CHECKED,
      sources: [
        { title: 'MiniMax M Plan overview', url: 'https://platform.minimax.io/docs/token-plan/intro.md' },
        { title: 'MiniMax M Plan FAQ', url: 'https://platform.minimax.io/docs/token-plan/faq.md' },
        { title: 'MiniMax CLI reference', url: 'https://platform.minimax.io/docs/m-plan/minimax-cli' },
        {
          title: 'MiniMax M Plan quick start',
          url: 'https://platform.minimax.io/docs/token-plan/quickstart.md',
        },
        { title: 'MiniMax error codes', url: 'https://platform.minimax.io/docs/api-reference/errorcode.md' },
        { title: 'MiniMax rate limits', url: 'https://platform.minimax.io/docs/guides/rate-limits.md' },
        {
          title: 'MiniMax prompt caching',
          url: 'https://platform.minimax.io/docs/api-reference/text-prompt-caching.md',
        },
        {
          title: 'MiniMax pay-as-you-go pricing',
          url: 'https://platform.minimax.io/docs/guides/pricing-paygo.md',
        },
        {
          title: 'MiniMax subscription service terms',
          url: 'https://agent.minimax.io/doc/en/payment-policy.html',
        },
        { title: 'MiniMax API privacy policy', url: 'https://platform.minimax.io/protocol/privacy-policy' },
        { title: 'MiniMax terms of service', url: 'https://www.minimax.io/terms-of-service-v2.html' },
      ],
      unconfirmed: [
        'Current MiniMax docs describe "M Plan" with tiers Go, Explore (3x usage) and Build (7.5x usage). Third-party pages still describe a "Token Plan" with Plus, Max and Ultra tiers at $20, $50 and $120. The product was likely renamed and restructured, and prices were not found on the official M Plan pages.',
        'A third-party summary says the plan is for individual interactive use; the official page we could read does not state an automation ban.',
        'Search results say API personal data is stored in a United States data centre, and a third-party analysis says the API terms let MiniMax use input and generated content to improve its services, with no opt-out and no explicit no-training promise. The privacy and terms pages did not render for our fetcher.',
        'The CLI says it "detects the service region from your key", and region can be set to cn or global. Third-party sources list api.minimax.io for global and api.minimaxi.com for China; the official pages we reviewed name only api.minimax.io.',
        'Search results describe `~/.mmx/config.json` and `~/.mmx/credentials.json` for the mmx CLI.',
      ],
      body: `MiniMax has two kinds of key that are billed separately and do not work for each other.

### Two kinds of key

Current MiniMax docs describe "M Plan" with tiers Go, Explore (3x usage) and Build (7.5x usage). Third-party pages still describe a "Token Plan" with Plus, Max and Ultra tiers at $20, $50 and $120. The product was likely renamed and restructured, and prices were not found on the official M Plan pages.

The CLI reference says the wizard accepts two key formats billed separately: Subscription keys (\`sk-cp-...\`) and pay-as-you-go keys (\`sk-api-...\`). The FAQ says they are "not interchangeable". The subscription base URL is https://api.minimax.io/anthropic.

The subscription key accesses "M Plan benefits and credit packs", while the standard API key "enables pay-as-you-go billing without plan limits". Credit packs are valid for one year from purchase. Unused plan usage does not carry over. The FAQ also says "Downgrades are not currently supported", and video varies by tier.

### Limits

- Text, image and audio follow both a 5-hour and a weekly window, while video models use only the weekly window. Video generation consumes far more usage than text.
- Pay-as-you-go limits are 200 RPM and 10,000,000 TPM for MiniMax-M3.1-Flash and MiniMax-M3. Image generation is 10 RPM.
- Error 2045 is a "Rate Growth Limit", triggered by sudden increases or decreases in request volume.

### Error codes

1008 is Insufficient Balance. 1002 is Rate Limit and 1039 is Token Limit; both say to retry later. 2056 is the plan window being used up ("wait for the resource release in the next 5-hour window"). 1004 and 2049 are authentication errors.

### Caching

Prompt caching is automatic and starts at 512 input tokens. Detect hits with \`usage.cache_read_input_tokens\` (Anthropic format) or \`usage.prompt_tokens_details.cached_tokens\` (OpenAI format). Cache reads are priced at $0.015 per million for M3.1-Flash and $0.06 for M3 up to 512k input. The pricing page does not state cache-write cost or TTL.

### Terms

The FAQ says subscription keys work "with any AI tool that supports the OpenAI-compatible or Anthropic-compatible protocol". Separately the subscription terms say "You may not lend, share, transfer, or otherwise permit others to use your account". A third-party summary says the plan is for individual interactive use; the official page we could read does not state an automation ban.

### Your data and region

Search results say API personal data is stored in a United States data centre, and a third-party analysis says the API terms let MiniMax use input and generated content to improve its services, with no opt-out and no explicit no-training promise. The privacy and terms pages did not render for our fetcher.

The CLI says it "detects the service region from your key", and region can be set to cn or global. Third-party sources list api.minimax.io for global and api.minimaxi.com for China; the official pages we reviewed name only api.minimax.io.

Search results describe \`~/.mmx/config.json\` and \`~/.mmx/credentials.json\` for the mmx CLI. The official CLI page confirms it writes config for other tools: \`~/.claude/settings.json\`, \`~/.codex/config.toml\`, \`~/.config/opencode/opencode.json\`, \`~/.hermes/config.yaml\` and \`~/.pi/agent/models.json\`. A user may already have a MiniMax key written into Claude Code or Codex settings.

### What NVX Ancile does about it

- The region (Global or China) is saved with the key and picks the base URL.
- It reads MiniMax's numeric code from the response body, even when the HTTP status is 200. 1008 is read as out of credit; 1002 as a rate limit; 1004 and 2049 as a key problem with a region hint.
- Code 2056 says to wait for the plan's next window, not to top up, and is not retried.
- Subscription keys (\`sk-cp-\`) and pay-as-you-go keys (\`sk-api-\`) are told apart, and the key hints say they are separate wallets.
- It reads both cache usage fields. It does not claim a TTL for MiniMax.
- NVX Ancile does not read other tools' settings files for a MiniMax key. Paste it.
- Telling subscription keys from pay-as-you-go keys by prefix, and showing two meters, are planned, not built.`,
    },
    {
      id: 'prov-alibaba',
      title: 'Alibaba Qwen (Model Studio)',
      summary:
        'Pay-as-you-go keys, Coding Plan and Token Plan keys, the free quota, regions and the rules for plan keys.',
      keywords:
        'Alibaba Qwen Model Studio DashScope Bailian Coding Plan Token Plan sk-sp free quota 90 days Singapore Beijing region Arrearage FreeTierOnly InvalidApiKey Qwen Code cache night discount training',
      checked: PROVIDERS_CHECKED,
      sources: [
        {
          title: 'Use Qwen Code with Model Studio',
          url: 'https://www.alibabacloud.com/help/id/model-studio/qwen-code',
        },
        { title: 'Model Studio error codes', url: 'https://help.aliyun.com/en/model-studio/error-code' },
        { title: 'Coding Plan FAQ', url: 'https://help.aliyun.com/en/model-studio/coding-plan-faq' },
        {
          title: 'Free quota for new users',
          url: 'https://www.alibabacloud.com/help/en/model-studio/new-free-quota.md',
        },
        {
          title: 'Model Studio regions and endpoints',
          url: 'https://help.aliyun.com/en/model-studio/regions',
        },
        {
          title: 'What is Model Studio',
          url: 'https://help.aliyun.com/en/model-studio/what-is-model-studio',
        },
        { title: 'Token Plan overview', url: 'https://help.aliyun.com/en/model-studio/token-plan-overview' },
        {
          title: 'Token Plan Personal Edition',
          url: 'https://help.aliyun.com/en/model-studio/token-plan-personal-overview',
        },
        { title: 'Coding Plan overview', url: 'https://help.aliyun.com/en/model-studio/coding-plan' },
        { title: 'Token Plan FAQ', url: 'https://help.aliyun.com/en/model-studio/token-plan-faq' },
        { title: 'Model Studio context cache', url: 'https://help.aliyun.com/en/model-studio/context-cache' },
        {
          title: 'Token Plan Team Edition',
          url: 'https://help.aliyun.com/en/model-studio/token-plan-team-overview',
        },
        {
          title: 'Qwen Code troubleshooting',
          url: 'https://qwenlm.github.io/qwen-code-docs/en/users/support/troubleshooting/',
        },
      ],
      unconfirmed: [
        'Whether NVX Ancile counts as a permitted tool is not stated: the Team Edition FAQ and the Coding Plan FAQ disagree on how open the door is.',
        'A third-party report says the free Qwen OAuth tier was closed on 15 April 2026; the CLI works with an API key or plan. No official page confirming this was reachable.',
      ],
      body: `Alibaba sells four things that look like one: pay as you go, a Coding Plan, and two Token Plans. Each has its own key and its own endpoint.

### Four products, four keys

Qwen Code's docs list Token Plan Personal, Token Plan Team, Coding Plan and pay-as-you-go. Pay-as-you-go uses a normal \`sk-\` key (\`BAILIAN_API_KEY\`) with a region-specific URL. Coding Plan and Token Plan keys start with \`sk-sp-\` and require their own base URL (coding.dashscope.aliyuncs.com for Coding Plan). Plan keys cannot be mixed with general endpoints.

### Which balance is spent

The docs state: "The system automatically applies deductions in the following priority order: free quota > resource plan > savings plan > pay-as-you-go." If "Free Quota Only" mode is on, the service stops with AllocationQuota.FreeTierOnly when the quota runs out. If it is off, calls continue at pay-as-you-go rates.

Plans never fall back. The Coding Plan FAQ says: "further API calls will fail with an error, and usage will not automatically switch to pay-as-you-go." Token Plan Team says that when seat quota is gone, calls are blocked and no pay-as-you-go charges apply, unless a shared usage pack is bought.

### Free quota

"Only models in the Singapore region with the service deployment scope set to International are eligible for a free quota." It is valid for 90 days from activation, model release or approval, whichever is latest, and expired quota is not reissued. A third-party source puts it at 1M tokens per proprietary Qwen model; the amount varies per model.

### Plan limits

Token Plan Personal gives 11,500 to 180,000 credits a month, resets monthly, and unused credits do not carry over. Coding Plan (200 yuan a month) allows up to 6,000 requests per 5 hours, 45,000 per week (reset Monday 00:00 UTC+8) and 90,000 per month. Credits and requests are different units. Token Plan is available only in the China (Beijing) region, with night discounts from 22:00 to 08:00 UTC+8.

### Errors

Arrearage (400) is "Access denied, please make sure your account is in good standing". AllocationQuota.FreeTierOnly (403) means the free tier is spent and free-only mode is on. Throttling.RateQuota and Throttling.BurstRate (429) are rate limits. InvalidApiKey (401) commonly means a key and base URL region mismatch. A plan key on the wrong endpoint also yields 401 or 403.

### Caching

Implicit cache is automatic, cannot be disabled and bills cached tokens at about 20% of input price. Explicit cache has a 5-minute TTL that resets on hit, a 1,024-token minimum, 125% creation cost and 10% hit cost. Explicit cache only pays off if the prefix is reused within five minutes.

### Terms for plan keys

See "Using your subscriptions in NVX Ancile" for the quoted rules. In short, the Coding Plan is for programming tools and Token Plan for interactive use only. Whether NVX Ancile counts as a permitted tool is not stated: the Team Edition FAQ and the Coding Plan FAQ disagree on how open the door is.

### Your data

Model Studio docs say: "Alibaba Cloud protects data privacy and will never use your data for model training." Token Plan Team says "Conversation data is not used for model training"; its FAQ contrasts this with the Individual edition, which does not carry the same statement. No retention period was found.

### Qwen Code

Settings live at \`~/.qwen/settings.json\`. Keys are referenced by environment variable name through \`envKey\`, such as \`BAILIAN_API_KEY\`, each with its own \`baseUrl\`. A third-party report says the free Qwen OAuth tier was closed on 15 April 2026; the CLI works with an API key or plan. No official page confirming this was reachable. Qwen Code's own docs say the free tier was discontinued on 2026-04-15.

### What NVX Ancile does about it

- The region (Singapore, Beijing or US Virginia) is saved with the key and picks the base URL. Frankfurt, Hong Kong, Tokyo and workspace hosts need a custom base URL on the model.
- Arrearage and AllocationQuota.FreeTierOnly are read as out of credit. Throttling codes are rate limits. InvalidApiKey is a key problem with a region hint.
- Qwen's implicit cache is left on. NVX Ancile does not turn on explicit caching.
- To get a hard stop at the end of the free quota, switch on Free Quota Only in the Alibaba console.
- A key starting \`sk-sp-\` is recognised as a plan key, and the key hints say plan keys never fall back to pay-as-you-go and only work at their own plan address.
- Binding a plan key to its base URL automatically, and an interactive-only warning for plan keys, are planned, not built.`,
    },
    {
      id: 'prov-zai',
      title: 'Z.ai (GLM)',
      summary: 'The GLM Coding Plan against the pay-as-you-go API, peak pricing, numeric errors and data.',
      keywords:
        'Z.ai Zhipu GLM Coding Plan BigModel 1113 1310 1316 error code peak off-peak credits 5-hour weekly Flash free caching Singapore data not stored ZCode region',
      checked: PROVIDERS_CHECKED,
      sources: [
        { title: 'GLM Coding Plan overview', url: 'https://docs.z.ai/devpack/overview' },
        { title: 'GLM Coding Plan FAQ', url: 'https://docs.z.ai/devpack/faq' },
        { title: 'GLM Coding Plan usage policy', url: 'https://docs.z.ai/devpack/usage-policy' },
        { title: 'Z.ai API error codes', url: 'https://docs.z.ai/api-reference/api-code' },
        { title: 'Z.ai pricing', url: 'https://docs.z.ai/guides/overview/pricing' },
        { title: 'Z.ai concepts and parameters', url: 'https://docs.z.ai/guides/overview/concept-param' },
        { title: 'Z.ai context caching', url: 'https://docs.z.ai/guides/capabilities/cache' },
        { title: 'Z.ai API introduction', url: 'https://docs.z.ai/api-reference/introduction' },
        { title: 'BigModel API introduction (Chinese)', url: 'https://docs.bigmodel.cn/cn/api/introduction' },
        {
          title: 'Z.ai privacy policy and data processing addendum',
          url: 'https://docs.z.ai/legal-agreement/privacy-policy.md',
        },
        {
          title: 'TechNode: Zhipu open sources ZCode after data dispute',
          url: 'https://technode.com/2026/09/21/zhipu-open-sources-zcode-after-data-dispute-and-plans-no-retention-controls-for-maas/',
        },
        { title: 'Coding Tool Helper', url: 'https://docs.z.ai/devpack/extension/coding-tool-helper.md' },
        { title: 'ZCode setup', url: 'https://docs.z.ai/devpack/tool/zcode.md' },
      ],
      unconfirmed: [
        'TechNode reports Zhipu apologised for a data-handling dispute and open-sourced ZCode. The article does not say what data was involved, and it is a news report, not a vendor statement.',
        '`@z_ai/coding-helper` loads a Coding Plan key into Claude Code, OpenCode, Crush and Factory Droid. The docs say it offers "secure local storage configuration" but give no file paths.',
      ],
      body: `Z.ai sells a Coding Plan and a pay-as-you-go API on separate endpoints.

### Two products

Coding Plan keys use https://api.z.ai/api/coding/paas/v4 (or /api/anthropic for Claude Code and Goose). The general API uses https://api.z.ai/api/paas/v4. The plan is billed in credits with 5-hour and weekly windows: Lite 2,000 and 10,000, Pro 12,000 and 60,000, Max 28,000 and 140,000. Lite is listed at $18 a month.

"Once the quota is used up, you'll need to wait until the next 5-hour cycle for it to refresh. The system will not deduct from your account balance." Only GLM-5.3 and GLM-5.3-Flash are supported on the plan.

### Peak pricing

Credits are charged by token multipliers (GLM-5.3: input 6.9, cached 1.7, output 24). "During off-peak hours, model usage is charged at 50% of the standard credit rate." Peak is Monday to Friday, 14:00 to 18:00 Singapore Standard Time (06:00 to 10:00 UTC).

### Free models

The pricing page lists GLM-4.7-Flash and GLM-4.5-Flash with input and output priced "Free". Newer Flash models, such as GLM-5.3-Flash at $0.15 per million input tokens, are paid. Free models carry concurrency limits that vary by account, and the docs publish no numbers.

### Terms

The Coding Plan is "strictly limited to use within officially supported tools and products". See "Using your subscriptions in NVX Ancile".

### Errors

1113 is no balance or resource package; 1305 is service overload; 1302 is rate limit; 1310 is a weekly or monthly limit; 1314 is an enterprise package expiring; 1316 and 1317 are 5-hour and 7-day caps; 1311 means the subscription does not include that model. All are HTTP 429. 1001 and 401 are authentication failures. In streaming, abnormal ends report through \`finish_reason\`.

Using unsupported tools triggers error 1113 or unauthorised balance deductions. The error reference defines 1113 as "Insufficient balance or no resource package. Please recharge." and returns it as HTTP 429. A balance error may really mean the plan key is being used outside its permitted scope.

### Caching

The docs describe "implicit caching that intelligently identifies repeated context content without manual configuration". Detect hits with \`usage.prompt_tokens_details.cached_tokens\`. Cached tokens bill at about 50% of standard, the pricing page shows lower cached rates per model, and cache storage is "Limited-time Free". TTL is not stated.

### Your data and region

The Data Processing Addendum says: "The Company do not store any of the content the Customer or its End Users provide or generate while using our Services." Customer data is "generally processed in Singapore". Zhipu announced a no-retention option for its MaaS platform in September 2026. Batch and File API data and data kept for legal or abuse reasons may still be retained. TechNode reports Zhipu apologised for a data-handling dispute and open-sourced ZCode. The article does not say what data was involved, and it is a news report, not a vendor statement.

Z.ai serves overseas users at api.z.ai and BigModel serves the mainland at open.bigmodel.cn. Credentials are per platform.

\`@z_ai/coding-helper\` loads a Coding Plan key into Claude Code, OpenCode, Crush and Factory Droid. The docs say it offers "secure local storage configuration" but give no file paths.

### What NVX Ancile does about it

- The platform (International or China) is saved with the key and picks the base URL. NVX Ancile does not read other tools' files for a Z.ai key.
- Codes 1302 and 1305 are retried. 1113, 1310, 1316 and 1317 are not retried: 1310, 1316 and 1317 say to wait for the plan's window, and 1113 says it may be a Coding Plan key used from a tool the plan does not cover. 1311 is read as a model this key cannot use.
- The pay-as-you-go endpoint is the default. A Coding Plan key needs the coding endpoint as the model's own base URL.
- Code 1113 is read as "top up" today. If you use a plan key, the plan may not cover this tool.
- Z.ai has no model list endpoint, so NVX Ancile's daily model check does not cover it.
- Showing the next 5-hour reset is planned, not built.`,
    },
    {
      id: 'prov-openrouter',
      title: 'OpenRouter',
      summary:
        'Credits and fees, free-model limits, bring-your-own-key, routing defaults and privacy filters.',
      keywords:
        'OpenRouter credits fee free models 50 requests a day 402 negative balance BYOK own keys shared capacity provider routing fallbacks data_collection zdr privacy caching session_id sticky routing',
      checked: PROVIDERS_CHECKED,
      sources: [
        { title: 'OpenRouter API limits', url: 'https://openrouter.ai/docs/api-reference/limits' },
        { title: 'OpenRouter FAQ', url: 'https://openrouter.ai/docs/faq' },
        { title: 'OpenRouter terms of service', url: 'https://openrouter.ai/terms' },
        { title: 'OpenRouter BYOK', url: 'https://openrouter.ai/docs/guides/overview/auth/byok' },
        { title: 'OpenRouter provider routing', url: 'https://openrouter.ai/docs/features/provider-routing' },
        { title: 'OpenRouter zero data retention', url: 'https://openrouter.ai/docs/guides/features/zdr' },
        {
          title: 'OpenRouter privacy and logging',
          url: 'https://openrouter.ai/docs/features/privacy-and-logging',
        },
        {
          title: 'OpenRouter prompt caching',
          url: 'https://openrouter.ai/docs/guides/best-practices/prompt-caching',
        },
        {
          title: 'OpenRouter: prompt caching and sticky routing',
          url: 'https://openrouter.ai/blog/tutorials/prompt-caching-sticky-routing/',
        },
        {
          title: 'OpenRouter: get current API key',
          url: 'https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key',
        },
      ],
      body: `OpenRouter is one account in front of many providers. That makes the question "who serves this?" as important as "who bills this?".

### Credits and fees

The FAQ states a 5.5% fee ($0.80 minimum) on card purchases and 5% on crypto. Unused credits can be expired after one year (365 days) from purchase. Refunds for unused credits can be requested within 24 hours of the transaction, and crypto payments are never refundable.

### Free models

Models with the \`:free\` suffix allow 20 requests a minute. Without any credit purchase the cap is 50 requests a day, and once you have bought at least $10 of credits (all-time) it rises to 1,000 a day. The limit counts purchases, not your current balance. If your credit balance drops below zero you may see 402 errors, including on free models.

### Your own keys

Using your own provider keys costs 5% of what the same model and provider would cost normally on OpenRouter, and the fee is taken from your OpenRouter credits. Pay-as-you-go plans include $25,000 a month of list-price usage before the fee applies. The two pages word this slightly differently, so confirm the exact threshold in the dashboard.

If every key hits a rate limit or fails, OpenRouter falls back to its own shared endpoints by default, so your request is billed to credits instead of your key. You can switch this off per provider, at the cost of rate-limit errors.

### Routing defaults

By default OpenRouter load balances across providers for a model, weighting by the inverse square of price, so the same model can be served by different providers on consecutive calls. \`allow_fallbacks\` defaults to true. Setting \`sort\` to price, throughput or latency turns load balancing off. Two identical requests may hit different providers with different quantisation, context limits and data policies.

### Privacy filters

\`data_collection\` defaults to allow; set to deny and only providers that do not collect user data are used. Setting \`zdr\` to true restricts routing to endpoints with a Zero Data Retention policy, and the per-request flag can only tighten, never relax, an account-level ZDR setting. The FAQ says prompts and completions are not logged by default, even on error, unless you opt in. Each provider has its own retention and training policy, and there are separate training opt-out settings for paid and free models.

### Caching

OpenAI, DeepSeek, Gemini 2.5+, Groq, Moonshot and Grok cache automatically. Anthropic models need a \`cache_control\` field, with at most four explicit breakpoints. After a cache hit is seen, OpenRouter routes later requests to the same provider. If you pass \`session_id\` (up to 256 characters), sticky routing starts on the first successful request.

### Errors

Platform rate limits return 429 with \`X-RateLimit-*\` headers. The 402 body can carry a reason such as \`in_flight_budget_exhausted\` (transient, retry later) or \`weight_exceeds_budget\` (lower \`max_tokens\` or the prompt, or add credits). Errors that happen after streaming has begun arrive as an event with \`finish_reason\` set to error.

### What NVX Ancile does about it

- A key is checked with OpenRouter's key endpoint (\`GET /api/v1/key\`), which answers 401 for a bad key and spends no tokens. The model list is not used for this, because OpenRouter's list is public and answers without any key.
- Routing presets (Recommended, Best quality, Lowest real cost, Fastest, Pinned, Advanced) build the \`provider\` object for each call. Every preset takes "Do not allow data collection", and Advanced can send \`zdr\`. Both can shrink the model list.
- After a call has used the cache, the next calls go to the same upstream. The pin lapses after ten quiet minutes.
- A stable \`session_id\` is sent on each call, with \`cache_control\` for Claude models.
- Answers show "Served by" the provider, and the billed cost replaces list price.
- A 402 is read as out of credit and is not retried.
- Planned, not built: showing the free-model allowance (50 or 1,000 a day), reading the 402 \`reason\`, and a warning that a BYOK model can bill OpenRouter credits.`,
    },
    {
      id: 'prov-fast-hosts',
      title: 'Fast inference hosts: Groq, Together, Fireworks and Cerebras',
      summary: 'Limits, caching, retention and billing for four hosts of open models.',
      keywords:
        'Groq Together Fireworks Cerebras fast inference host open models free tier rate limit 429 prompt caching zero data retention ZDR spend limit build tier gpt-oss free trial',
      checked: PROVIDERS_CHECKED,
      sources: [
        { title: 'Groq rate limits', url: 'https://console.groq.com/docs/rate-limits' },
        { title: 'Groq prompt caching', url: 'https://console.groq.com/docs/prompt-caching' },
        { title: 'Groq your data', url: 'https://console.groq.com/docs/your-data' },
        {
          title: 'Together build tiers',
          url: 'https://support.together.ai/articles/2650779384-build-tiers-required-spend-and-rate-limits',
        },
        {
          title: 'Together free tier changes July 2025',
          url: 'https://support.together.ai/articles/1862638756-changes-to-free-tier-and-billing-july-2025',
        },
        { title: 'Together rate limits', url: 'https://docs.together.ai/docs/rate-limits' },
        { title: 'Together privacy policy', url: 'https://www.together.ai/privacy' },
        {
          title: 'Fireworks rate limits and quotas',
          url: 'https://docs.fireworks.ai/guides/quotas_usage/rate-limits',
        },
        { title: 'Fireworks prompt caching', url: 'https://docs.fireworks.ai/guides/prompt-caching' },
        {
          title: 'Fireworks data handling',
          url: 'https://docs.fireworks.ai/guides/security_compliance/data_handling',
        },
        { title: 'Cerebras rate limits', url: 'https://inference-docs.cerebras.ai/support/rate-limits' },
        {
          title: 'Cerebras prompt caching',
          url: 'https://inference-docs.cerebras.ai/capabilities/prompt-caching',
        },
        {
          title: 'Does Cerebras retain my data',
          url: 'https://cerebras-inference.help.usepylon.com/articles/1811589793-does-cerebras-retain-my-data',
        },
        { title: 'Cerebras privacy policy', url: 'https://www.cerebras.ai/privacy-policy' },
      ],
      unconfirmed: [
        'No official Together page on prompt caching, discounts or TTL could be fetched. Do not assume automatic caching or a discount.',
        'Cerebras states that it does not retain prompt content, requests, responses or logs, only account and usage metrics for billing and performance. Search results also describe inference as processed in US-based data centres.',
      ],
      body: `These four hosts serve open models quickly. They differ most in what is free, and in who keeps your prompts.

### Groq

- Rate limits apply to the organisation, not the user, so teammates share one quota. Groq tracks requests and tokens per minute and per day (plus audio seconds), and you hit a 429 as soon as any one is reached. Free and Developer plans have different allocations.
- \`x-ratelimit-limit-requests\` is the daily request limit, while \`x-ratelimit-limit-tokens\` is the per-minute token limit. \`retry-after\` is only sent when a 429 occurs.
- Caching is supported only on openai/gpt-oss-20b, openai/gpt-oss-120b and openai/gpt-oss-safeguard-20b, with a 50% discount and a 2 hour expiry. The discount does not stack with the batch discount.
- Groq does not retain customer inference data by default. Logs may be kept for up to 30 days when troubleshooting or investigating suspected abuse, and customers can enable Zero Data Retention. Data is held in GCP buckets in the United States. The page does not state a training policy.

### Together

- Access needs a minimum $5 credit purchase and no free trial is offered. Build Tiers are based on lifetime spend: Tier 1 at $5 (600 RPM for LLMs), Tier 2 at $50 (1,800), Tier 3 at $100 (3,000), Tier 4 at $250 (4,500), Tier 5 at $1,000 (6,000). Free credits do not raise your tier; real spend does.
- When demand is high Together may limit requests, so a 429 may not match the published tier number. A 429 means slow down with exponential backoff, and a 503 means wait briefly and retry.
- Together will not use your data to train its models without explicit opt-in. By default it retains prompts and responses. You can turn on Zero Data Retention in Privacy and Security settings.
- No official Together page on prompt caching, discounts or TTL could be fetched. Do not assume automatic caching or a discount.

### Fireworks

- Fireworks bills from prepaid credits. Accounts with a payment method and credits can reach 6,000 RPM; accounts without a payment method are capped at 10 RPM. Adding credits does not raise or reset a monthly spend limit you have set.
- An HTTP 429 on deployment endpoints typically means the deployment is saturated rather than that you hit a TPM tier cap.
- Prompt caching is enabled for all models. On serverless the default discount is 50%, varying by model. Serverless keeps separate caches per account; dedicated deployments share one cache unless \`x-prompt-cache-isolation-key\` is set.
- Fireworks does not log or store prompt or generation data for open models without explicit opt-in. With the Responses API and \`store=True\`, conversations are kept and deleted after 30 days; set \`store=False\` or call the DELETE endpoint. It does log metadata such as token counts.

### Cerebras

- Free trial limits for gpt-oss-120b are 5 RPM, 30K uncached TPM, 90K total TPM, 1M tokens an hour and 1M a day. The paid Developer tier lifts this to 1K RPM and 1M uncached TPM with no hourly or daily caps. Capacity refills continuously as a token bucket. The 429 message says whether the uncached or total limit was exceeded.
- Caching is automatic with a guaranteed 5 minute TTL, in 128-token blocks, and there is no discount.
- Cerebras states that it does not retain prompt content, requests, responses or logs, only account and usage metrics for billing and performance. Search results also describe inference as processed in US-based data centres.

### What NVX Ancile does about it

- All four are used through their OpenAI-compatible chat endpoints with an API key. NVX Ancile does not use Fireworks' Responses API, so \`store\` does not apply.
- Fireworks gets an \`x-session-affinity\` header with the conversation's cache key.
- Cerebras caching is treated as speed, not price: no saving is shown.
- A 402 from Together or Cerebras is read as out of credit. A Fireworks 412, observed for a spend limit or no payment method, is read the same way but not treated as certain. 429 is a rate limit on all four.
- Do not read Groq's rate-limit headers as all per-minute. NVX Ancile shows no countdown for Cerebras.
- Planned, not built: a Together zero-retention reminder and showing your Fireworks spend limit.`,
    },
    {
      id: 'prov-cloudflare',
      title: 'Cloudflare Workers AI',
      summary: '10,000 free neurons a day, separate request limits, and what is stored.',
      keywords:
        'Cloudflare Workers AI neurons free daily limit reset UTC AI Gateway logging training data account id',
      checked: PROVIDERS_CHECKED,
      sources: [
        {
          title: 'Workers AI pricing',
          url: 'https://developers.cloudflare.com/workers-ai/platform/pricing/',
        },
        { title: 'Workers AI limits', url: 'https://developers.cloudflare.com/workers-ai/platform/limits/' },
        {
          title: 'Workers AI data usage',
          url: 'https://developers.cloudflare.com/workers-ai/platform/data-usage/',
        },
      ],
      body: `Workers AI counts use in neurons and gives a free allowance every day.

### Limits

Both Free and Paid Workers plans get 10,000 neurons a day at no charge, and limits reset at 00:00 UTC. On the Free plan you cannot go beyond that and further operations fail with an error until you upgrade. On Paid you are charged $0.011 per 1,000 neurons above the allocation.

Request rate limits are separate from neurons. Text generation allows 300 requests a minute. Models that need the Workers Paid plan have lower limits of 20 requests a minute on standard billing or 50 with prepaid AI Gateway credits. So a 429 can be a request rate limit even with neurons left.

### Your data

Cloudflare says it does not use Customer Content processed by Workers AI to train AI models, and standard inference does not retain inputs or outputs after delivery. Storage happens if you use R2, KV, Durable Objects or Vectorize, enable logging or caching, or use async or batch features. Operational metadata such as token counts and timestamps is kept. Third-party models remain subject to their own licences.

### What NVX Ancile does about it

- Cloudflare is used with an API token. The address needs your account id, so the model carries its own base URL.
- A 429 is a rate limit and is retried with backoff.
- If you route through AI Gateway with logging or caching on, prompts are then stored. NVX Ancile does not warn about this yet.
- Showing the reset as UTC midnight is planned, not built.`,
    },
    {
      id: 'prov-huggingface',
      title: 'Hugging Face Inference Providers',
      summary:
        'Monthly credits, what a custom provider key changes, and why the provider that answers matters.',
      keywords:
        'Hugging Face Inference Providers HF credits PRO $2 fastest cheapest preferred provider suffix X-HF-Bill-To custom provider key data policy',
      checked: PROVIDERS_CHECKED,
      sources: [
        {
          title: 'Inference Providers pricing',
          url: 'https://huggingface.co/docs/inference-providers/pricing',
        },
        {
          title: 'Inference Providers overview',
          url: 'https://huggingface.co/docs/inference-providers/index',
        },
      ],
      unconfirmed: [
        'Hugging Face acts as a proxy in front of many providers. The pages we read describe billing and routing but not a single retention or training policy, so the policy of whichever provider serves the request applies. This is an inference from how the service is described, not a quoted statement.',
      ],
      body: `Hugging Face sits in front of many providers and bills them through one account.

### Credits

Free users get no included credit and must buy credits to use Inference Providers. PRO gets $2.00 a month and Team or Enterprise gets $2.00 per seat. These are general compute credits that can also pay for Inference Endpoints, Spaces hardware and Jobs, and they apply before pay-as-you-go billing. Hugging Face adds no markup to provider rates.

### Your own provider key

Requests routed by Hugging Face are billed to your Hugging Face account and use the monthly credits. If you set your own provider key in Hugging Face settings, the provider bills you directly, Hugging Face does not charge, and the included credits do not apply. Team and Enterprise members must send \`X-HF-Bill-To\` with the organisation name to use the organisation's credits.

### Which provider answers

With no suffix, Hugging Face selects the fastest available provider by throughput, not the cheapest. Append \`:cheapest\` for the lowest output price, \`:preferred\` to follow your settings order, or a provider name such as \`:groq\` to pin one. Automatic failover only applies with automatic selection.

### Your data

Hugging Face acts as a proxy in front of many providers. The pages we read describe billing and routing but not a single retention or training policy, so the policy of whichever provider serves the request applies. This is an inference from how the service is described, not a quoted statement.

### What NVX Ancile does about it

- Hugging Face has no provider profile of its own. You can add it as an OpenAI-compatible endpoint, which NVX Ancile reads conservatively: a key is only called bad on a 401 or 403 that sounds like authentication.
- Showing which provider answered is planned, not built. Today only OpenRouter answers say who served them.
- For cost-sensitive use, name the provider with a suffix rather than relying on \`:fastest\`.`,
    },
    {
      id: 'prov-ollama',
      title: 'Ollama',
      summary:
        'Models on your computer, the keep-alive and context defaults, the local server and Ollama cloud.',
      keywords:
        'Ollama local models keep_alive context length num_ctx OLLAMA_MODELS localhost 11434 cloud Pro Max concurrency slow first token privacy free',
      checked: PROVIDERS_CHECKED,
      sources: [
        { title: 'Ollama FAQ', url: 'https://docs.ollama.com/faq' },
        { title: 'Ollama context length', url: 'https://docs.ollama.com/context-length' },
        { title: 'Ollama pricing', url: 'https://ollama.com/pricing' },
        { title: 'Ollama cloud', url: 'https://docs.ollama.com/cloud' },
        { title: 'Ollama terms', url: 'https://ollama.com/terms' },
      ],
      unconfirmed: [
        'Ollama says it processes cloud prompts and responses to answer requests and does not use them to train models. Retention periods and hosting regions are not stated on the pages we read.',
      ],
      body: `Ollama runs models on your own computer, so there is no key and no bill. It also has a paid cloud.

### Where models live

Models are stored in \`~/.ollama/models\` on macOS, \`/usr/share/ollama/.ollama/models\` on Linux (service install) and \`C:\\Users\\%username%\\.ollama\\models\` on Windows. Set \`OLLAMA_MODELS\` to use another directory. Large models fill the system drive by default.

### Slow first reply and keep-alive

By default a model stays in memory for 5 minutes after the last request. \`OLLAMA_KEEP_ALIVE\` sets the default and the \`keep_alive\` request parameter overrides it, accepting durations, seconds or a negative number to keep the model loaded indefinitely. The first request after unloading is slow because the model reloads.

### Context length

The FAQ says the default context window is 4096 tokens, set with \`OLLAMA_CONTEXT_LENGTH\` or \`num_ctx\` per request. The newer context-length page says the default depends on VRAM: 4k under 24 GiB, 32k from 24 to 48 GiB, 256k at 48 GiB or more. Which default applies depends on the installed version.

### The local server

Ollama binds 127.0.0.1 port 11434 by default and \`OLLAMA_HOST\` changes this. It allows cross-origin requests from 127.0.0.1 and 0.0.0.0 by default. \`OLLAMA_NUM_PARALLEL\` defaults to 1 request per model at a time. Ollama says it does not see your prompts when you run locally. Another app on the same machine can use the same server, and exposing \`OLLAMA_HOST\` beyond localhost has no authentication.

### Ollama cloud

The pricing page lists Free ($0, starter credits, 1 concurrent cloud request), Pro ($20 a month, $60 of usage credits, 3 concurrent) and Max ($100 a month, $300 of usage credits, 10 concurrent). Included usage resets monthly on the day your subscription started and unused usage does not carry over. Ollama says it processes cloud prompts and responses to answer requests and does not use them to train models. Retention periods and hosting regions are not stated on the pages we read. Cloud models leave your machine.

### What NVX Ancile does about it

- Models you have pulled are found by themselves, within 30 seconds, and listed as \`ollama/<name>\`.
- It sends the context length explicitly with each request, so a long prompt is not silently cut to a small default.
- The "Loaded now" strip in Admin, Models shows what is in memory and offers Unload and Keep loaded, which set \`keep_alive\`.
- A slow first token after idle is normal.
- Showing the model folder and its size is planned, not built.`,
    },
    {
      id: 'prov-lmstudio',
      title: 'LM Studio',
      summary: "Just-in-time loading, the idle timer and the local server's network and token settings.",
      keywords:
        'LM Studio local server port 1234 JIT loading idle TTL auto-evict model directory API token network',
      checked: PROVIDERS_CHECKED,
      sources: [
        {
          title: 'LM Studio TTL and auto-evict',
          url: 'https://lmstudio.ai/docs/developer/core/ttl-and-auto-evict',
        },
        {
          title: 'LM Studio OpenAI-compatible endpoints',
          url: 'https://lmstudio.ai/docs/app/api/endpoints/openai',
        },
        {
          title: 'LM Studio server settings',
          url: 'https://lmstudio.ai/docs/developer/core/server/settings',
        },
        { title: 'LM Studio download a model', url: 'https://lmstudio.ai/docs/app/basics/download-model' },
      ],
      unconfirmed: [
        'The docs say you can change the models directory under My Models, but the default path was not stated on the page we read. It is commonly `~/.lmstudio/models`, which is not confirmed.',
      ],
      body: `LM Studio is another way to run models on your own computer.

### Loading and unloading

Just-in-time loading is on by default, so other apps can request a model without it being loaded first. Idle TTL defaults to 60 minutes and resets on each request. Auto-evict is on by default and unloads previously JIT-loaded models before loading another, so at most one JIT-loaded model stays in memory. Two apps using different models will evict each other.

### The local server

The OpenAI-compatible server examples use port 1234 and any OpenAI client works by changing the base URL. Server settings include serving on the local network, an authentication switch that requires an API token in the Authorization header, and CORS. Whether authentication is off by default was not stated on the pages we read. If you turn on network serving without authentication, anyone on the network can use your models.

### Model folder

The docs say you can change the models directory under My Models, but the default path was not stated on the page we read. It is commonly \`~/.lmstudio/models\`, which is not confirmed.

### What NVX Ancile does about it

- LM Studio is read as a local OpenAI-compatible server, the same way as Ollama. Add it as a model on your own server with its address, which is usually port 1234.
- NVX Ancile does not set LM Studio's idle timer or load models for it.
- Expect a reload delay when two models take turns.`,
    },
    {
      id: 'prov-runpod',
      title: 'RunPod',
      summary:
        'Per-second billing, what a stopped pod still costs, serverless idle time and what a zero balance does.',
      keywords:
        'RunPod pod GPU billing per second stopped pod storage network volume zero balance terminated serverless flex active worker idle timeout cost',
      checked: PROVIDERS_CHECKED,
      sources: [
        { title: 'RunPod pod pricing', url: 'https://docs.runpod.io/pods/pricing' },
        { title: 'RunPod network volumes', url: 'https://docs.runpod.io/storage/network-volumes' },
        { title: 'RunPod serverless pricing', url: 'https://docs.runpod.io/serverless/pricing' },
      ],
      body: `RunPod rents GPUs by the second. Stopping a pod does not stop every charge.

### Pods

Pods are billed by the second for compute and storage, with no fees for ingress or egress. A stopped pod stops compute charges but its volume disk keeps accruing at $0.20 per GB a month, while container disk charges stop. Container disk is erased when the pod stops; volume disk persists until the pod is deleted.

### A zero balance

When your balance reaches $0, pods are stopped automatically. Pods without a network volume are terminated and their data cannot be recovered. Pods with a network volume are stopped and the data kept, but if the balance stays at zero the volume may eventually be terminated and its data is unrecoverable.

### Network volumes

Network volumes cost $0.07 per GB a month for the first 1 TB and $0.05 beyond. Charges continue while the pod is stopped. Volumes are location-constrained: attaching one to Serverless limits worker deployment to that data centre, and pods must pick a volume's data centre at deploy time.

### Serverless

Flex workers scale to zero and bill per second from start to full stop, rounded up. A worker keeps running and billing during its idle timeout (default 5 seconds) before scaling down. Cold start time from worker start until the handler is ready is billed. Active workers run all the time.

### What NVX Ancile does about it

- Compute keeps a pod's hourly and storage rates, shows a stopped pod's storage cost separately, and projects the month.
- Terminate always asks, because it destroys the pod's container disk. The network volume survives.
- Model weights are kept on a network volume so a node can be stopped and started without downloading them again.
- Serverless endpoints are not managed by NVX Ancile.
- A warning before your RunPod balance runs low is planned, not built.`,
    },
    {
      id: 'prov-claude-code',
      title: 'Claude Code: paying and privacy',
      summary:
        'What changes when Claude Code answers, from the plan you sign in with to what it writes to disk.',
      keywords:
        'Claude Code subscription plan API key Bedrock Vertex sign in claude auth status plan limits transcripts ~/.claude telemetry training retention feedback survey privacy mode DISABLE_TELEMETRY',
      checked: PROVIDERS_CHECKED,
      sources: [
        { title: 'Claude Code CLI reference', url: 'https://code.claude.com/docs/en/cli-reference' },
        {
          title: 'Use the Claude Agent SDK with your Claude plan',
          url: 'https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan',
        },
        {
          title: 'Claude Code legal and compliance',
          url: 'https://code.claude.com/docs/en/legal-and-compliance',
        },
        { title: 'Claude Code data usage', url: 'https://code.claude.com/docs/en/data-usage' },
        { title: 'Explore the .claude directory', url: 'https://code.claude.com/docs/en/claude-directory' },
        { title: 'Claude Code sessions', url: 'https://code.claude.com/docs/en/sessions' },
        { title: 'Agent SDK sessions', url: 'https://code.claude.com/docs/en/agent-sdk/sessions' },
        {
          title: 'Monthly API credits for Max and Team plans',
          url: 'https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-and-team-plans',
        },
      ],
      body: `Claude Code is the one coding engine NVX Ancile drives today. Your own installed Claude Code answers, signed in as you.

### Who pays

Claude Code can sign in with a Claude subscription (OAuth) or use Claude Console API billing (\`claude auth login --console\`), or a cloud provider such as Amazon Bedrock. Subscription use draws on plan limits; API use bills per token. On 7 October 2026 Anthropic said Max and Team plans include monthly API credits covering the Agent SDK, \`claude -p\`, the API and Managed Agents, and that these tools can still be used with subscription limits.

### Terms

Anthropic does not permit third-party developers to "route requests through Free, Pro, or Max plan credentials on behalf of their users". Developers building products with the Agent SDK should use API key authentication. An end user may sign in to the unmodified Claude Code binary with their own subscription, and advertised Pro and Max limits assume ordinary individual usage. Running Claude Code inside another product requires the Commercial Terms, and customers may not pay for, resell or intermediate Claude usage on end users' behalf.

### Training and retention

For Free, Pro and Max accounts, data is used for training only if the setting is on, and retention is 5 years if allowed and 30 days if not. Team, Enterprise, API and third-party platform use is not used for training unless the customer opts in, with 30 day standard retention and zero data retention for qualified accounts. The \`/feedback\`, \`/bug\` and \`/share\` commands send the transcript, retained for 5 years.

### On your disk

Transcripts are JSONL files at \`~/.claude/projects/<project>/<session-id>.jsonl\`. They are plaintext and include file contents and command output from tools. They are deleted after \`cleanupPeriodDays\` (default 30). \`CLAUDE_CONFIG_DIR\` moves everything. See "Where your chat is saved" for running without saving and for deleting.

### Sessions and names

Sessions created with \`claude -p\` or the Agent SDK are left out of the picker and out of \`claude --continue\`, though they can be resumed by ID. Resuming by ID searches the current project then every other project on the machine.

### Telemetry and surveys

Metrics are on by default for the Claude API and off for Bedrock, Vertex and Foundry. \`DISABLE_TELEMETRY=1\` turns off metrics, \`DISABLE_ERROR_REPORTING=1\` error reports, \`DISABLE_FEEDBACK_COMMAND=1\` the feedback command, and \`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC\` disables non-essential traffic including surveys. Metrics are said to never include code, prompts or file paths. The WebFetch safety check still sends hostnames to api.anthropic.com unless \`skipWebFetchPreflight\` is set.

### What NVX Ancile does about it

- It drives your own installed, verified Claude Code through Anthropic's Agent SDK, never \`claude -p\`, and never collects or proxies your Claude tokens. It does not present a subscription as its own provider.
- Claude Code models follow how Claude Code is signed in. A claude.ai sign-in shows as Plan, and an API key, Bedrock, Vertex or Foundry sign-in shows as pay per use.
- A shared install must not use one person's subscription for several people.
- With Claude Code usage reporting off in Settings, sessions run with \`DISABLE_TELEMETRY\`. The other switches are not set.
- Runs started by NVX Ancile through the SDK will not show in your normal Claude Code picker. The session id is stored with the thread.
- Planned (CS1): a "do not save this run" switch and deleting engine copies. Setting the other privacy variables as a privacy mode is planned, not built.`,
    },
    {
      id: 'prov-coding-clis',
      title: 'Other coding CLIs you may use',
      summary:
        'Codex, Gemini CLI, Copilot CLI, Cursor, Qwen Code, Kimi CLI and OpenCode: what they charge and what they keep.',
      keywords:
        'Codex Gemini CLI GitHub Copilot CLI Cursor CLI Qwen Code Kimi CLI OpenCode Zen coding agent subscription weekly pool AI Credits free tier ended archived auto-reload privacy mode',
      checked: PROVIDERS_CHECKED,
      sources: [
        { title: 'Codex authentication', url: 'https://learn.chatgpt.com/docs/auth' },
        { title: 'Codex pricing and plans', url: 'https://learn.chatgpt.com/docs/pricing.md' },
        {
          title: 'Codex advanced configuration',
          url: 'https://learn.chatgpt.com/docs/config-file/config-advanced',
        },
        { title: 'Codex CLI commands', url: 'https://learn.chatgpt.com/docs/developer-commands?surface=cli' },
        { title: 'OpenCode providers', url: 'https://opencode.ai/docs/providers/' },
        {
          title: 'Gemini CLI quota and pricing',
          url: 'https://github.com/google-gemini/gemini-cli/blob/main/docs/resources/quota-and-pricing.md',
        },
        { title: 'Gemini CLI terms and privacy', url: 'https://geminicli.com/docs/resources/tos-privacy/' },
        {
          title: 'Gemini CLI enterprise',
          url: 'https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/enterprise.md',
        },
        {
          title: 'Gemini CLI session management',
          url: 'https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/session-management.md',
        },
        {
          title: 'Copilot moving to usage-based billing',
          url: 'https://github.blog/changelog/2026/04/27/github-copilot-is-moving-to-usage-based-billing/',
        },
        {
          title: 'Copilot premium requests',
          url: 'https://docs.github.com/en/copilot/concepts/billing/copilot-requests',
        },
        {
          title: 'About Copilot CLI session data',
          url: 'https://docs.github.com/en/copilot/concepts/agents/copilot-cli/chronicle',
        },
        {
          title: 'Copilot CLI command reference',
          url: 'https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference',
        },
        {
          title: 'Responsible use of Copilot CLI',
          url: 'https://docs.github.com/en/copilot/responsible-use/copilot-cli',
        },
        { title: 'Cursor pricing', url: 'https://cursor.com/docs/account/pricing' },
        { title: 'Cursor data use', url: 'https://cursor.com/data-use' },
        { title: 'Cursor security', url: 'https://cursor.com/security' },
        { title: 'Using Cursor CLI', url: 'https://cursor.com/docs/cli/using' },
        { title: 'Cursor CLI authentication', url: 'https://cursor.com/docs/cli/reference/authentication' },
        { title: 'Cursor terms of service', url: 'https://cursor.com/terms-of-service' },
        {
          title: 'Qwen Code authentication',
          url: 'https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/',
        },
        {
          title: 'Qwen Code settings',
          url: 'https://qwenlm.github.io/qwen-code-docs/en/users/configuration/settings/',
        },
        { title: 'Qwen Code repository', url: 'https://github.com/QwenLM/qwen-code' },
        { title: 'Kimi CLI documentation', url: 'https://moonshotai.github.io/kimi-cli/en/' },
        {
          title: 'Kimi data locations',
          url: 'https://moonshotai.github.io/kimi-cli/en/configuration/data-locations.html',
        },
        { title: 'Kimi Code membership guide', url: 'https://www.kimi.com/help/kimi-code/membership-guide' },
        { title: 'Kimi Code docs', url: 'http://www.kimi.com/code/docs/' },
        { title: 'OpenCode CLI', url: 'https://opencode.ai/docs/cli/' },
        { title: 'OpenCode troubleshooting', url: 'https://opencode.ai/docs/troubleshooting/' },
        { title: 'OpenCode Zen', url: 'https://opencode.ai/docs/zen/' },
      ],
      unconfirmed: [
        'The CLI page points to separate notices: the Gemini Code Assist for individuals privacy notice for personal Google accounts, the Google Privacy Policy for unpaid API keys, and the Google Cloud Privacy Notice for Vertex AI. It does not itself say whether prompts are used for training.',
        'The responsible use page does not state retention periods or training use for GitHub-hosted models.',
        '`CURSOR_API_KEY` is the variable for automation, but the docs we read did not state where chats are stored on disk or how to delete one.',
        'Prompts go to whichever provider you configure.',
      ],
      body: `NVX Ancile has no engine for these tools yet. This is what is known about each, for when you use them in a terminal. For where each keeps your chats, see "Where your chat is saved". For their terms, see "Using your subscriptions in NVX Ancile".

### OpenAI Codex

Signing in with ChatGPT uses your plan's included usage and follows your ChatGPT workspace data permissions. An API key bills your OpenAI Platform account at standard API rates and follows your API organisation's retention and data-sharing settings. Some features that depend on ChatGPT workspace access or cloud services are limited or unavailable with an API key. For CI, OpenAI recommends API key authentication.

Plus and standard Business plans have 5 hour windows for local messages, and weekly limits may apply across plans. Pro plans currently have no five hour limit. After limits run out you can buy credits or run extra local chats with an API key at standard rates. If you hit a limit mid-turn, the agent can finish that turn subject to fair use.

### Gemini CLI

The quota page lists 1,000 model requests per user per day for a Google account on the free Code Assist route, and 250 a day for an unpaid Gemini API key, restricted to Flash. Google AI Pro is listed at 1,500 and Ultra at 2,000 a day. \`/stats model\` shows usage. The page is in the project repository and may lag the live service.

The CLI page points to separate notices: the Gemini Code Assist for individuals privacy notice for personal Google accounts, the Google Privacy Policy for unpaid API keys, and the Google Cloud Privacy Notice for Vertex AI. It does not itself say whether prompts are used for training. Usage statistics can be turned off with \`privacy.usageStatisticsEnabled\` set to false.

### GitHub Copilot CLI

GitHub replaced premium request units with AI Credits, consumed by token use at published model rates. Pro includes $10 a month of credits, Pro+ $39, Business $19 a user and Enterprise $39 a user. Monthly Pro and Pro+ users migrated automatically, while annual subscribers stay on premium request billing (300 or 1,500 a month, $0.04 each extra) until their plan expires. Completions and Next Edit suggestions do not use credits.

The responsible use page does not state retention periods or training use for GitHub-hosted models. With a bring-your-own model provider, prompts, code context and responses go directly to that provider and not through GitHub.

### Cursor CLI

Each paid plan has one pool of usage for Cursor models shared across the editor agent, CLI and cloud agents. It refreshes weekly. When it runs out you can wait for the reset, use prepaid credit (top-ups or auto top-up) or upgrade. Plans listed are Free, Plus $8, Premium $30, Super $100 and Ultra $200 a month.

With Privacy Mode on, Cursor does not train on your data and says it has zero data retention agreements with all model providers. With it off, Cursor may store and use code data and prompts to train its models. Even with your own API key, requests still go through Cursor's backend. \`CURSOR_API_KEY\` is the variable for automation, but the docs we read did not state where chats are stored on disk or how to delete one.

### Qwen Code

The Qwen Code docs say the Qwen OAuth free tier was discontinued on 2026-04-15 and that cached tokens may work briefly before new requests are rejected. Current routes are QwenCloud (Token Plan subscription or pay-as-you-go API key), Alibaba Cloud Coding Plan, Alibaba Cloud Token Plan, or third-party providers such as OpenRouter, DeepSeek and Kimi. Prompts go to whichever provider you configure.

### Kimi CLI

The Kimi CLI documentation says the project is archived and no longer maintained, that existing installations will stop working, and that users should migrate to Kimi Code CLI.

### OpenCode

OpenCode Zen is pay as you go with per-million-token pricing. If the balance falls below $5 it automatically reloads $20, and card fees (4.4% plus $0.30) are passed on at cost. Some models are free for a limited time. OpenCode says its providers follow a zero-retention policy and do not train on your data, with exceptions: during promotional periods data from free models such as Big Pickle may be used to improve the model, and OpenAI and Anthropic retain requests for 30 days. All Zen models are hosted in the US and EU.

### What NVX Ancile does about it

- None of these is an engine in NVX Ancile today, and NVX Ancile never reads their sign-in files. Adding Codex and Gemini CLI engines follows the Claude Code pattern in docs/engines.md.
- Because Cursor's limit is one pool, a limit reached in the editor also blocks the CLI.
- Do not rely on a "free" label for Qwen Code or the Zen free models without reading the dates above.`,
    },
  ],
};
