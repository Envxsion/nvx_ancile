/**
 * ------------------------------------------------------------------
 *  Title    |  The sample world
 *  ID       |  seed
 * ------------------------------------------------------------------
 *  Purpose  |  Everything `pnpm seed` creates, written as data: four
 *           |  notebooks with their sources, a dozen threads (several
 *           |  of them real trees), fact-checks, memory, notes,
 *           |  grants and notifications. Original writing throughout.
 *  How      |  Messages are listed with local keys and a parent key.
 *           |  `cites` maps a citation number in the text to a search
 *           |  (source key + query); the seeder runs the search and
 *           |  stores the real chunk and span. Factcheck claims are
 *           |  exact substrings of the answer.
 * ------------------------------------------------------------------
 */

export const MODELS = {
  sonnet: 'anthropic/claude-sonnet-5-5',
  opus: 'anthropic/claude-opus-5-5',
  haiku: 'anthropic/claude-haiku-4-5',
  gpt: 'openai/gpt-5.5',
  gemini: 'google/gemini-3-pro',
};

export const NOTEBOOKS = [
  {
    key: 'launch',
    title: 'Fernway 2.0 launch',
    slug: 'fernway-2-0-launch',
    color: 'azure',
    description: 'Pricing, messaging and the plan for the 18 November launch.',
    daysAgo: 24,
    pinned: true,
    sources: [
      { key: 'brief', file: 'fernway-launch-brief.md', title: 'Launch brief v3' },
      { key: 'pricing', file: 'fernway-pricing-research.md', title: 'Pricing research summary' },
      { key: 'kickoff', file: 'fernway-kickoff-notes.md', title: 'Kick-off meeting notes, 22 September' },
      { key: 'survey', file: 'fernway-beta-survey.csv', title: 'Beta survey by city', upload: 'text/csv' },
    ],
  },
  {
    key: 'heat',
    title: 'Heat pump for Elm Grove',
    slug: 'heat-pump-for-elm-grove',
    color: 'jade',
    description: 'Sizing, quotes and the grant for replacing the gas boiler.',
    daysAgo: 21,
    grounded: true,
    sources: [
      { key: 'survey', file: 'elm-grove-survey.md', title: 'Heat loss survey, 14 Elm Grove' },
      {
        key: 'explainer',
        file: 'heat-pump-explainer.md',
        title: 'How an air-source heat pump heats a house',
      },
      { key: 'quotes', file: 'installer-quotes.md', title: 'Installer quotes compared' },
      { key: 'bus', file: 'bus-grant-notes.md', title: 'Boiler Upgrade Scheme notes' },
    ],
  },
  {
    key: 'novel',
    title: 'The Salt Road',
    slug: 'the-salt-road',
    color: 'magenta',
    description: 'A novel draft: Holy Island, 1998, a drowning that was not an accident.',
    daysAgo: 23,
    sources: [
      { key: 'ch1', file: 'salt-road-chapter-one.md', title: 'Chapter one, draft 4' },
      { key: 'bible', file: 'salt-road-characters.md', title: 'Character bible' },
      { key: 'outline', file: 'salt-road-outline.md', title: 'Outline: acts and turns' },
    ],
  },
  {
    key: 'tax',
    title: 'Studio accounts 2025 to 26',
    slug: 'studio-accounts-2025-to-26',
    color: 'amber',
    description: 'Self Assessment for the illustration studio: expenses, allowances, payments.',
    daysAgo: 19,
    sources: [
      { key: 'ledger', file: 'studio-expenses.csv', title: 'Expenses ledger', upload: 'text/csv' },
      { key: 'hmrc', file: 'hmrc-allowances-notes.md', title: 'Sole trader tax notes' },
      { key: 'ruth', file: 'accountant-email.md', title: 'Email from Ruth (accountant), 12 March' },
    ],
  },
];

/* ---- Threads ---------------------------------------------------------------
   Message fields:
     k        local key           p      parent key (null for the root)
     role     'user'|'assistant'  text   markdown
     model    MODELS key          at     minutes after the thread starts
     editOf   key of the user message this one edits
     cites    { n: [sourceKey, query] }  for [n] markers in text
     fallback { from: MODELS key, reason, detail }  requested model that failed
     tools    [{ tool, args, result, ok }]  shown before the text
   --------------------------------------------------------------------------- */

export const THREADS = [
  /* 1. Pricing: an edited question, a regeneration, two named branches. */
  {
    key: 'pricing',
    notebook: 'launch',
    title: 'Pricing Plus for the November launch',
    daysAgo: 3,
    hour: 9,
    pinned: true,
    head: 'a3',
    messages: [
      {
        k: 'u1',
        p: null,
        role: 'user',
        at: 0,
        text: 'Using the pricing research, what should Plus cost at launch, and should the store page lead with the monthly or the annual price?',
      },
      {
        k: 'a1',
        p: 'u1',
        role: 'assistant',
        model: 'sonnet',
        at: 1,
        cites: {
          1: ['pricing', 'Revenue per 100 respondents peaks at £4.99'],
          2: ['pricing', 'annual price was shown first 46% picked annual'],
          3: ['brief', 'Plus £4.99 monthly £39.99 annual 33% discount'],
          4: ['kickoff', 'launch offer is a 30-day free trial of Plus'],
        },
        text: `**Price Plus at £4.99 a month or £39.99 a year, and lead with the annual price.**

**Monthly price.** £4.99 is the revenue-maximising point in the beta survey: 29% said they would subscribe at that price, and revenue per 100 respondents peaks there before the steep drop at £5.99 [1].

**Lead with annual.** The order matters more than the discount. When the annual price was shown first, 46% of Plus subscribers chose annual, against 22% when monthly came first [2]. Interviewees read the annual price as "the grown-up option" when it led.

**Annual price.** £39.99 is a 33% discount on paying monthly, which is already in the brief, and finance has asked for no deeper discount at launch [3].

**Trial.** Keep the 30-day trial agreed at kick-off rather than a price cut [4]. In the beta, a 30-day trial converted at 25% against 18% for 14 days, and riders said a month is the minimum to judge a route through some bad weather.

| | Monthly | Annual |
|---|---|---|
| Plus | £4.99 | £39.99 (save 33%) |
| Shown on the store page | Second | **First** |

One thing to watch: most rivals have raised their prices this year, so £4.99 may look low against them by spring.`,
      },
      {
        k: 'u2',
        p: 'a1',
        role: 'user',
        at: 6,
        text: 'Finance think the annual discount is too generous. What happens if we price annual at £44.99 instead?',
      },
      {
        k: 'a2',
        p: 'u2',
        role: 'assistant',
        model: 'sonnet',
        at: 7,
        cites: {
          1: ['brief', 'annual Plus price is a 33% discount finance discount'],
          2: ['pricing', 'annual price was shown first grown-up option'],
        },
        text: `At £44.99 the annual plan becomes a 25% discount instead of 33% [1]. The research does not test that price directly, so this is a judgement rather than a finding.

What the research does say is that the annual share was driven mainly by *which price came first*, not by the size of the saving [2]. So a smaller discount probably costs you less than you would fear, as long as annual still leads on the store page.

My estimate, for planning only:

- Annual take-up falls from about 46% to somewhere between 38% and 42% of new Plus subscribers.
- Revenue per annual subscriber rises by £5 in the first year.
- Net, the two roughly cancel out in year one; £44.99 wins slightly if renewals hold.

If finance want the higher price, test it: run £39.99 and £44.99 to half the launch traffic each for the first two weeks.`,
      },
      {
        k: 'u2b',
        p: 'a1',
        role: 'user',
        at: 9,
        editOf: 'u2',
        text: 'Finance think the annual discount is too generous. Could we keep £39.99 but shorten the trial to 14 days instead?',
      },
      {
        k: 'a2b',
        p: 'u2b',
        role: 'assistant',
        model: 'sonnet',
        at: 10,
        cites: {
          1: ['pricing', '14-day trial converted at 18% 30-day trial converted at 21%'],
          2: ['pricing', 'two weeks of rain and you have learned nothing'],
          3: ['kickoff', 'launch offer is a 30-day free trial'],
        },
        text: `I would keep the 30-day trial. Shortening it saves less than it costs.

In the beta, a 14-day trial converted at 18% and a 30-day trial at 21% [1]. On 40,000 launch installs, if a quarter start a trial, that gap is roughly 300 paying subscribers. The longer trial does cost twice as much in free usage, but free usage of a route planner is cheap to serve.

The qualitative reason matters too: riders said a fortnight is too short to judge something that depends on the weather [2]. A short trial in November risks people cancelling after two wet weeks.

It was also agreed at kick-off as the launch offer instead of a discount [3]. If finance need a concession, a smaller annual discount is the lesser evil.`,
      },
      {
        k: 'a2c',
        p: 'u2b',
        role: 'assistant',
        model: 'gpt',
        at: 12,
        cites: {
          1: ['pricing', '14-day trial converted at 18% 30-day trial converted at 21%'],
        },
        text: `Short answer: you can, but it is the more expensive way to please finance.

- **Conversion.** 30 days converted at 21% and 14 days at 18% in the beta [1]. Three points of conversion on the launch cohort is worth more than the free usage you save.
- **Timing.** A November launch means your trial runs through the darkest, wettest weeks. Two weeks may not include a single good commute.
- **Alternative.** Keep 30 days and move annual to £44.99 if finance insist on a change. The research suggests the order of prices on the page matters more than the discount.

I would put both options to finance with the numbers, and recommend the second.`,
      },
      {
        k: 'u3',
        p: 'a2b',
        role: 'user',
        at: 20,
        text: 'Agreed, the trial stays. Draft the pricing section for the help centre, plain and short.',
      },
      {
        k: 'a3',
        p: 'u3',
        role: 'assistant',
        model: 'sonnet',
        at: 21,
        text: `## Fernway plans and prices

**Free** covers standard routes and up to three saved routes. It is free for as long as you like.

**Plus** adds Calm Routes, live disruption alerts and unlimited saved routes. It costs £39.99 a year, or £4.99 a month.

**Teams** is for employers: £36 per seat a year, or £3.50 per seat a month, with a minimum of 20 seats and a dashboard for your scheme administrator.

### Try Plus free for 30 days

Start a trial from the app. We remind you three days before it ends, and you can cancel in Settings at any time before then without paying anything.

### Changing or cancelling

You can switch between monthly and annual billing at any time; the change takes effect at your next renewal. Cancelling stops renewal, and you keep Plus until the end of the period you have paid for.`,
      },
    ],
    branches: [
      { name: 'Annual at £44.99', color: 'amber', fork: 'a1', head: 'a2' },
      { name: 'Keep the trial', color: 'jade', fork: 'a1', head: 'a3' },
    ],
    factchecks: [
      {
        message: 'a1',
        verifier: 'gpt',
        claims: [
          {
            text: 'revenue per 100 respondents peaks there before the steep drop at £5.99',
            importance: 1,
            verdict: 'supported',
            evidence: [['pricing', 'Revenue per 100 respondents peaks at £4.99', 'supports', 0.96]],
            rationale:
              'The research states that revenue per 100 respondents peaks at £4.99 and that the drop to £5.99 is the steepest in the curve.',
          },
          {
            text: 'When the annual price was shown first, 46% of Plus subscribers chose annual, against 22% when monthly came first',
            importance: 1,
            verdict: 'supported',
            evidence: [['pricing', 'annual price was shown first 46% picked annual', 'supports', 0.97]],
            rationale: 'Both figures appear in the research summary exactly as stated.',
          },
          {
            text: 'a 30-day trial converted at 25% against 18% for 14 days',
            importance: 0.8,
            verdict: 'contradicted',
            evidence: [
              ['pricing', '30-day trial converted at 21% cost twice as much', 'contradicts', 0.95],
              ['kickoff', 'launch offer is a 30-day free trial of Plus', 'neutral', 0.42],
            ],
            rationale:
              'The research gives 21% for the 30-day trial, not 25%. The 14-day figure of 18% is correct.',
          },
          {
            text: 'most rivals have raised their prices this year',
            importance: 0.4,
            verdict: 'insufficient',
            evidence: [
              ['pricing', 'Most mainstream cycling apps charge between £3.99 and £7.99', 'neutral', 0.38],
            ],
            rationale:
              'The sources give current competitor price ranges but say nothing about recent increases.',
          },
        ],
      },
    ],
  },

  /* 2. The launch email: a deep tree with four forks, later merged. */
  {
    key: 'email',
    notebook: 'launch',
    title: 'Launch announcement email',
    daysAgo: 4,
    hour: 14,
    head: 'a3',
    messages: [
      {
        k: 'u1',
        p: null,
        role: 'user',
        at: 0,
        text: 'Draft the launch email to the newsletter list. Lead with Calm Routes, mention alerts and shared commutes, and keep it warm.',
      },
      {
        k: 'a1',
        p: 'u1',
        role: 'assistant',
        model: 'sonnet',
        at: 1,
        cites: { 1: ['brief', 'Calm Routes quieter roads fewer junctions less climbing'] },
        text: `**Subject:** The quieter way to work is here

Hi {first_name},

You told us the hardest part of cycling to work isn't the hills or the weather. It's the main roads.

So we built **Calm Routes**. Fernway 2.0 now finds the way in that trades a few minutes for quieter streets, fewer junctions and less climbing, scored from council traffic counts and thousands of real commutes [1].

Two more things arrive with it:

- **Live alerts** for roadworks and closures on your usual route, before you set off.
- **Shared commutes**, so you can meet a colleague on the way in.

Fernway 2.0 is in the App Store and Google Play from 18 November. Update the app, open any saved route and look for the green badge.

See you on the quiet roads,
The Fernway team`,
      },
      {
        k: 'a1b',
        p: 'u1',
        role: 'assistant',
        model: 'gpt',
        at: 3,
        text: `**Subject:** Fernway 2.0: your commute, minus the traffic

Hi {first_name},

Every route planner can find you the fastest way to work. Fernway 2.0 finds you a calmer one.

**Calm Routes** weighs up traffic, junctions and hills, then offers a route that might take three minutes longer and feel thirty minutes shorter. You'll see a score on every route, so you can decide for yourself.

Also new: live alerts for roadworks on your route, and shared commutes for riding in with a friend.

Available from 18 November. Just update the app.

Ride well,
Fernway`,
      },
      { k: 'u2', p: 'a1', role: 'user', at: 8, text: 'Good. Make it punchier and under 120 words.' },
      {
        k: 'a2',
        p: 'u2',
        role: 'assistant',
        model: 'sonnet',
        at: 9,
        text: `**Subject:** Main roads, meet your replacement

Hi {first_name},

Fernway 2.0 brings **Calm Routes**: the way to work with fewer cars, fewer junctions and less climbing. It might add a few minutes. It takes away the bit you dread.

Plus:
- Live roadworks and closure alerts
- Shared commutes with colleagues

Out 18 November. Update the app and look for the green badge.

The Fernway team`,
      },
      {
        k: 'u2b',
        p: 'a1',
        role: 'user',
        at: 11,
        editOf: 'u2',
        text: 'Good. Make it more formal; this version also goes to the employers on our Teams waiting list.',
      },
      {
        k: 'a2b',
        p: 'u2b',
        role: 'assistant',
        model: 'sonnet',
        at: 12,
        text: `**Subject:** Introducing Fernway 2.0 and Calm Routes

Dear {first_name},

We are pleased to announce Fernway 2.0, available from 18 November.

The release introduces **Calm Routes**, which recommends cycling routes with lower traffic, fewer junctions and less climbing. Each route carries a score based on council traffic data and anonymised journeys from our riders, so that cyclists can choose with confidence.

Fernway 2.0 also adds live alerts for roadworks and closures, and shared commutes for colleagues travelling together.

Existing users will receive the update automatically.

Kind regards,
The Fernway team`,
      },
      {
        k: 'u3',
        p: 'a2',
        role: 'user',
        at: 15,
        text: 'Add one line about the 30-day free trial of Plus, and make the date unmissable.',
      },
      {
        k: 'a3',
        p: 'u3',
        role: 'assistant',
        model: 'sonnet',
        at: 16,
        cites: { 1: ['kickoff', '30-day free trial of Plus'] },
        text: `**Subject:** 18 November: main roads, meet your replacement

Hi {first_name},

**On 18 November**, Fernway 2.0 brings **Calm Routes**: the way to work with fewer cars, fewer junctions and less climbing. It might add a few minutes. It takes away the bit you dread.

Plus:
- Live roadworks and closure alerts
- Shared commutes with colleagues

**Try Plus free for 30 days** [1]. No card needed until the trial ends.

Update the app on the 18th and look for the green badge.

The Fernway team`,
      },
      {
        k: 'a3b',
        p: 'u3',
        role: 'assistant',
        model: 'opus',
        at: 18,
        text: `**Subject:** Tuesday 18 November. Quieter roads start here.

Hi {first_name},

Mark the date: **Tuesday 18 November**.

That's when Fernway 2.0 brings Calm Routes to your phone: commutes with fewer cars, fewer junctions and less climbing. A few minutes longer, a lot less stressful.

Also new: live alerts for roadworks, and shared commutes so you can ride in together.

And for the first month it's on us: **every rider gets 30 days of Plus free**.

Update on the 18th. Look for the green badge.

The Fernway team`,
      },
      {
        k: 'u4',
        p: 'a2b',
        role: 'user',
        at: 22,
        text: 'Add a short paragraph for the employers about Fernway Teams and the pilots.',
      },
      {
        k: 'a4',
        p: 'u4',
        role: 'assistant',
        model: 'sonnet',
        at: 23,
        cites: {
          1: ['brief', 'Teams £3.50 per seat minimum 20 seats admin dashboard'],
          2: ['brief', 'Five employer pilots on Fernway Teams 50 seats'],
        },
        text: `Here is the paragraph, to sit after the feature list:

> **For employers.** Fernway Teams brings Calm Routes to your whole workforce for £3.50 per seat a month, with a minimum of 20 seats and a dashboard showing uptake across your scheme, never individual journeys [1]. We are running a small number of launch pilots this autumn; if you would like one of the places, reply to this email and our partnerships team will be in touch [2].

I kept it to two sentences so the consumer message still leads. If this version is going only to employers, I would move it to the top.`,
      },
    ],
    branches: [
      { name: 'Punchy', color: 'coral', fork: 'a1', head: 'a3' },
      { name: 'Formal for employers', color: 'azure', fork: 'a1', head: 'a4' },
    ],
    merge: { title: 'Launch email: final draft', a: 'a3', b: 'a4', picks: ['u3', 'a3', 'u4', 'a4'] },
  },

  /* 3. Kick-off actions: today, ends in a real approval waiting for you. */
  {
    key: 'actions',
    notebook: 'launch',
    title: 'Kick-off actions and owners',
    daysAgo: 0,
    hour: 8,
    head: 'a1',
    approval: {
      ask: 'Save that table as team/launch-actions.md in the workspace so the team can see it.',
      intro: "I'll save the table to `team/launch-actions.md` in your workspace.",
      path: 'team/launch-actions.md',
      content: `# Launch actions

| Action | Owner | Due | Status |
|---|---|---|---|
| Load test at five times beta traffic | Tom | 13 October | At risk |
| Final App Store screenshots | Aisha | 20 October | On track |
| DPIA pack for the Bristol pilot | Marcus | 10 October | Due this week |
| Help article: how Calm Routes are scored | Hannah | 3 November | On track |
| Press list and embargo letter | Priya | 27 October | On track |
| Submit 2.0 build to Apple | Tom | 10 November | Depends on load test |
`,
    },
    messages: [
      {
        k: 'u1',
        p: null,
        role: 'user',
        at: 0,
        text: 'Pull the actions from the kick-off notes into one table, and flag anything that looks at risk.',
      },
      {
        k: 'a1',
        p: 'u1',
        role: 'assistant',
        model: 'sonnet',
        at: 1,
        cites: {
          1: ['kickoff', 'Load test at five times beta traffic Tom 13 October'],
          2: ['kickoff', 'last test reached three times beta traffic latency two seconds'],
          3: ['brief', "Apple's review times four to six days submitted by 10 November"],
          4: ['kickoff', 'hospital needs a data protection impact assessment'],
        },
        text: `Six actions came out of the kick-off [1]:

| Action | Owner | Due | Risk |
|---|---|---|---|
| Load test at five times beta traffic | Tom | 13 Oct | **High** |
| Final App Store screenshots (score badge) | Aisha | 20 Oct | Low |
| DPIA pack for the Bristol hospital pilot | Marcus | 10 Oct | Medium |
| Help article: how Calm Routes are scored | Hannah | 3 Nov | Low |
| Press list and embargo letter | Priya | 27 Oct | Low |
| Submit the 2.0 build to Apple | Tom | 10 Nov | **High** |

**At risk**

- **The load test.** The last run only reached three times beta traffic before latency passed two seconds [2], and Tom asked for a week of work before trying five times. If it slips past 13 October it squeezes everything after it.
- **The Apple submission** depends on the load test. Review is taking four to six days, so 10 November is the last safe date for an 18 November launch [3].
- **The DPIA** is the only thing blocking the Bristol pilot from signing [4], and it is due this week.`,
      },
    ],
  },

  /* 4. Sizing the heat pump: long, sealed by a fact-check, compacted, two branches. */
  {
    key: 'sizing',
    notebook: 'heat',
    title: 'How big a heat pump do we need?',
    daysAgo: 5,
    hour: 19,
    head: 'a5a',
    messages: [
      {
        k: 'u1',
        p: null,
        role: 'user',
        at: 0,
        text: 'From the survey, what size heat pump does the house need? Dad thinks a 7 kW one would do.',
      },
      {
        k: 'a1',
        p: 'u1',
        role: 'assistant',
        model: 'sonnet',
        at: 1,
        cites: {
          1: ['survey', 'total design heat loss of 8.4 kW'],
          2: ['survey', 'air-source heat pump of 9 kW nominal output 7 kW unit would fall short'],
          3: ['survey', 'Insulate under the suspended ground floor cut the design heat loss by about 1.2 kW'],
        },
        text: `The survey recommends a **9 kW** heat pump, and your dad's 7 kW would be too small as things stand.

The house loses 8.4 kW of heat on the coldest design day, minus 2.2 °C outside [1]. The surveyor recommends a 9 kW unit at that condition, and says a 7 kW unit would fall short on the coldest days while a 12 kW unit would cycle too often in spring and autumn [2].

Your dad's instinct isn't wrong in spirit, though. Insulating under the suspended ground floor would cut the heat loss by about 1.2 kW [3], which brings the house close to what a 7 kW unit can manage.`,
      },
      {
        k: 'u2',
        p: 'a1',
        role: 'user',
        at: 5,
        text: 'If we insulate the floor first, could we get away with the 7 kW unit after all?',
      },
      {
        k: 'a2',
        p: 'u2',
        role: 'assistant',
        model: 'sonnet',
        at: 6,
        cites: {
          1: ['survey', 'cut the design heat loss by about 1.2 kW'],
          2: ['explainer', 'rated to keep working down to minus 15 °C efficiency falls'],
        },
        text: `Probably not comfortably.

Floor insulation takes the design heat loss from 8.4 kW to about 7.2 kW [1]. A 7 kW unit's rating is its output at a mild test condition; at minus 2 °C most 7 kW models deliver nearer 6 to 6.5 kW. You would be short by roughly 10% on the coldest days, which means the house drifts a degree or so below target or the backup heater runs.

Heat pumps keep working well below freezing [2], so nothing breaks; it just costs more and feels cooler on the worst nights. I would still insulate the floor, because it makes a 9 kW unit run more efficiently, but size for 9 kW.`,
      },
      {
        k: 'u3',
        p: 'a2',
        role: 'user',
        at: 11,
        text: 'What flow temperature should we ask the installer to commission it at, and what does that mean for running costs?',
      },
      {
        k: 'a3',
        p: 'u3',
        role: 'assistant',
        model: 'sonnet',
        at: 12,
        cites: {
          1: ['survey', 'radiators sized for a 50 °C flow temperature'],
          2: ['explainer', 'Every degree lower improves efficiency by roughly 2 to 3%'],
          3: ['explainer', 'each kilowatt-hour of heat costs about 7.7p gas boiler 7.2p'],
        },
        text: `Ask for **50 °C at the design condition**, with weather compensation so it runs cooler on milder days. The survey sizes the new radiators for a 50 °C flow [1], so that is the highest it should need to go.

Each degree you take off the flow temperature improves efficiency by roughly 2 to 3% [2], so a system that spends most of the winter at 40 to 45 °C does noticeably better than one held at 50.

On running costs, at 24.5p per kWh and a seasonal efficiency of 3.2, a kilowatt-hour of heat costs about 7.7p, against about 7.2p from your gas boiler [3]. So expect roughly the same bills on a standard tariff, and lower ones on a time-of-use tariff.

| | Cost per kWh of heat |
|---|---|
| Gas boiler, 88% efficient | 7.2p |
| Heat pump, SCOP 3.2, standard tariff | 7.7p |
| Heat pump, SCOP 3.6, 7.5p overnight tariff | about 2.1p overnight |`,
      },
      {
        k: 'u4',
        p: 'a3',
        role: 'user',
        at: 18,
        text: 'Remind me how the grant works, and whether the timing of the install matters.',
      },
      {
        k: 'a4',
        p: 'u4',
        role: 'assistant',
        model: 'sonnet',
        at: 19,
        cites: {
          1: ['bus', 'grant of £7,500 towards an air-source heat pump'],
          2: ['bus', 'installer applies for the grant takes it off the invoice'],
          3: ['bus', 'voucher is valid for three months installer has to reapply'],
        },
        text: `The Boiler Upgrade Scheme gives a grant of £7,500 towards an air-source heat pump [1]. The installer applies for the grant and takes it off the invoice, so you never handle the money [2].

Timing does matter: once the installer applies, the voucher stays valid for six months [3], so don't let them apply until you have an install date. Most installers in Leeds are booked about two months ahead this autumn, so it is worth choosing one soon.`,
      },
      {
        k: 'u5a',
        p: 'a4',
        role: 'user',
        at: 26,
        text: "Let's plan the radiators. Which ones actually have to change?",
      },
      {
        k: 'a5a',
        p: 'u5a',
        role: 'assistant',
        model: 'sonnet',
        at: 27,
        compacted: true,
        cites: {
          1: ['survey', 'Room heat loss existing radiator output shortfall'],
          2: ['survey', 'Replace four radiators lounge hall bedroom 1 bathroom'],
        },
        text: `Four of the seven need to change, the ones that can't meet the room's heat loss at a 50 °C flow [1]:

| Room | Needs (W) | Current radiator gives (W) | Change? |
|---|---|---|---|
| Through-lounge | 2,310 | 1,480 | **Yes** |
| Hall and landing | 1,050 | 610 | **Yes** |
| Bedroom 1 | 1,180 | 990 | **Yes** |
| Bathroom | 680 | 420 | **Yes** |
| Kitchen-diner | 1,640 | 1,720 | No |
| Bedroom 2 | 980 | 1,010 | No |
| Bedroom 3 | 560 | 640 | No |

That matches the surveyor's recommendation of four larger double-panel convectors [2]. If you insulate the floor first, look again at the lounge: it is the room that gains most, and it might get by with its current radiator plus a second small one.`,
      },
      {
        k: 'u5b',
        p: 'a4',
        role: 'user',
        at: 31,
        text: 'What if we put underfloor heating in downstairs instead of new radiators?',
      },
      {
        k: 'a5b',
        p: 'u5b',
        role: 'assistant',
        model: 'opus',
        at: 32,
        compacted: true,
        cites: {
          1: ['survey', 'ground floor is suspended timber over a ventilated void no insulation'],
          2: ['explainer', 'Every degree lower improves efficiency'],
        },
        text: `It can work well, and it suits a heat pump, but your floor makes it a bigger job than it sounds.

The ground floor is suspended timber over a ventilated void [1]. Underfloor heating there means lifting the boards, fitting insulation and spreader plates between the joists, then relaying. The insulation is the part the survey already wants, so some of the work does double duty.

The payoff is efficiency: underfloor heating runs at 35 to 40 °C instead of 50, and each degree lower is worth 2 to 3% [2]. Over a year that could lift the system's seasonal efficiency from about 3.2 to 3.6.

The costs to weigh:

- Roughly £4,000 to £6,000 for the through-lounge and kitchen-diner, on top of the install.
- A week or two without a usable ground floor.
- You would still need new radiators upstairs in bedroom 1 and the bathroom.

If you are replacing the floor finish anyway, do it. If not, the four radiators are the simpler route.`,
      },
    ],
    branches: [
      { name: 'Radiators first', color: 'jade', fork: 'a4', head: 'a5a' },
      { name: 'Underfloor downstairs', color: 'amber', fork: 'a4', head: 'a5b' },
    ],
    compaction: {
      upto: 'a3',
      summary: `Earlier in this thread: the survey's design heat loss is 8.4 kW and it recommends a 9 kW air-source heat pump; a 7 kW unit falls short on the coldest days, even after floor insulation (which saves about 1.2 kW). Commission at 50 °C flow with weather compensation; each degree lower gains 2 to 3% efficiency. Running costs are close to gas on a standard tariff (7.7p against 7.2p per kWh of heat) and lower on a time-of-use tariff.`,
      tokensBefore: 3480,
      tokensAfter: 1210,
    },
    factchecks: [
      {
        message: 'a1',
        verifier: 'gpt',
        claims: [
          {
            text: 'The house loses 8.4 kW of heat on the coldest design day',
            importance: 1,
            verdict: 'supported',
            evidence: [['survey', 'total design heat loss of 8.4 kW', 'supports', 0.97]],
            rationale:
              'The survey gives a total design heat loss of 8.4 kW at the design outdoor temperature.',
          },
          {
            text: 'a 7 kW unit would fall short on the coldest days while a 12 kW unit would cycle too often in spring and autumn',
            importance: 1,
            verdict: 'supported',
            evidence: [
              ['survey', '7 kW unit would fall short 12 kW unit would cycle too often', 'supports', 0.95],
            ],
            rationale: 'The recommendations section says exactly this.',
          },
          {
            text: 'Insulating under the suspended ground floor would cut the heat loss by about 1.2 kW',
            importance: 0.8,
            verdict: 'supported',
            evidence: [['survey', 'Insulate under the suspended ground floor cut 1.2 kW', 'supports', 0.94]],
            rationale: 'The survey estimates the saving at about 1.2 kW.',
          },
        ],
      },
      {
        message: 'a4',
        verifier: 'gpt',
        claims: [
          {
            text: 'The Boiler Upgrade Scheme gives a grant of £7,500 towards an air-source heat pump',
            importance: 1,
            verdict: 'supported',
            evidence: [
              ['bus', 'grant of £7,500 towards an air-source heat pump', 'supports', 0.98],
              ['quotes', 'After £7,500 grant', 'supports', 0.71],
            ],
            rationale: 'Stated in the grant notes and used in all three quotes.',
          },
          {
            text: 'The installer applies for the grant and takes it off the invoice',
            importance: 0.8,
            verdict: 'supported',
            evidence: [['bus', 'installer applies for the grant takes it off the invoice', 'supports', 0.96]],
            rationale: 'The grant notes say the installer applies and deducts it from the invoice.',
          },
          {
            text: 'the voucher stays valid for six months',
            importance: 0.9,
            verdict: 'contradicted',
            evidence: [
              ['bus', 'voucher is valid for three months for an air-source heat pump', 'contradicts', 0.97],
              ['bus', 'installer has to reapply', 'contradicts', 0.62],
            ],
            rationale:
              'The grant notes say the voucher is valid for three months for an air-source heat pump, not six.',
          },
          {
            text: 'Most installers in Leeds are booked about two months ahead this autumn',
            importance: 0.4,
            verdict: 'insufficient',
            evidence: [['quotes', 'Earliest install January November February', 'neutral', 0.44]],
            rationale:
              'The quotes give earliest install months for three firms, which is not enough to say how booked-up installers in Leeds are generally.',
          },
        ],
      },
    ],
  },

  /* 5. Comparing quotes: Opus was asked for and Sonnet answered. */
  {
    key: 'quotes',
    notebook: 'heat',
    title: 'Compare the three installer quotes',
    daysAgo: 2,
    hour: 20,
    head: 'a2',
    messages: [
      {
        k: 'u1',
        p: null,
        role: 'user',
        at: 0,
        text: 'Compare the three installer quotes against what the survey recommends. Show the price after the grant.',
      },
      {
        k: 'a1',
        p: 'u1',
        role: 'assistant',
        model: 'sonnet',
        fallback: {
          from: 'opus',
          reason: 'capacity',
          detail: '529 overloaded_error: Overloaded. Retried twice in 6 s, then moved on.',
        },
        at: 1,
        cites: {
          1: ['quotes', 'Heat pump Vaillant Mitsubishi Daikin quoted price after grant'],
          2: ['survey', 'air-source heat pump of 9 kW nominal output'],
          3: ['survey', 'Replace four radiators'],
          4: ['quotes', 'Brightwater only installer to include under-floor insulation £1,900'],
        },
        text: `Here they are side by side, checked against the survey [1]:

| | Northern Heat Co. | Aire Valley | Brightwater |
|---|---|---|---|
| Unit size | 10 kW (above 9 kW) | 8.5 kW (below 9 kW) | **9 kW** |
| Radiators replaced | **4** | 6 | **4** |
| Floor insulation | No | No | **Yes** |
| Price after grant | £6,450 | **£4,900** | £8,300 |
| Workmanship warranty | 2 years | **5 years** | 3 years |
| Predicted SCOP | 3.6 | 3.3 | **3.8** |

**Against the survey.** Only Brightwater quotes the recommended 9 kW unit [2] and the four radiators the survey identifies [3]. Northern Heat Co. go a size up "for headroom". Aire Valley go slightly under, and replace two radiators the survey says are fine.

**Like for like.** Brightwater's price includes about £1,900 of floor insulation the others leave out [4]. Take that off and it is roughly £6,400 after the grant, level with Northern Heat Co.`,
      },
      { k: 'u2', p: 'a1', role: 'user', at: 6, text: 'So which would you pick?' },
      {
        k: 'a2',
        p: 'u2',
        role: 'assistant',
        model: 'sonnet',
        at: 7,
        cites: { 1: ['quotes', 'vague about the flow temperature they would commission at'] },
        text: `**Brightwater**, if you can wait until February.

It is the only quote that matches the survey on every point that affects comfort and running costs: the right unit size, the right radiators and the floor insulation. It also predicts the best seasonal efficiency, 3.8, which over fifteen years outweighs the higher upfront price.

If you need heat this winter, **Northern Heat Co.** is the safe second choice. Their figures matched the survey and they can install in January.

I would not choose Aire Valley despite the price. An undersized unit and a vague answer on flow temperature [1] are the two things most likely to give you a cold house and high bills.`,
      },
    ],
  },

  /* 6. The opening paragraph: three models, three regenerations. */
  {
    key: 'opening',
    notebook: 'novel',
    title: 'Tighten the opening paragraph',
    daysAgo: 9,
    hour: 22,
    head: 'a1',
    messages: [
      {
        k: 'u1',
        p: null,
        role: 'user',
        at: 0,
        cites: {},
        text: `Tighten this without losing the image of the posts:

> The tide had already turned when Mara reached the causeway, and the posts that marked the safe way across were standing in water up to their shins. She stopped where the tarmac gave out and looked at them for a long time.`,
      },
      {
        k: 'a1',
        p: 'u1',
        role: 'assistant',
        model: 'opus',
        at: 1,
        text: `> The tide had turned before Mara reached the causeway. The posts that marked the safe way across stood shin-deep in the water, and she stopped where the tarmac ran out and watched them.

What changed, and why:

- **"had already turned" → "had turned before"**: the "before" carries the lateness, so "already" can go.
- **Split into two sentences**, so the tide and Mara each get their own beat.
- **"standing in water up to their shins" → "stood shin-deep in the water"**: the posts are still people-like, in fewer words.
- **"looked at them for a long time" → "watched them"**: "watched" implies the duration, and it is a verb that waits.

I kept "safe way across" because it sets up the posts being moved later in the book.`,
      },
      {
        k: 'a1b',
        p: 'u1',
        role: 'assistant',
        model: 'gemini',
        at: 3,
        text: `## Revised opening

> The tide had turned by the time Mara reached the causeway. The posts marking the safe way across stood up to their shins in water. Where the tarmac gave out, she stopped, and looked at them for a long time.

## Notes

- Shorter first sentence for a stronger hook.
- Kept "up to their shins" for the personification.
- Kept "for a long time" to slow the pace before the dialogue.`,
      },
      {
        k: 'a1c',
        p: 'u1',
        role: 'assistant',
        model: 'gpt',
        at: 5,
        text: `> When Mara reached the causeway the tide had already turned, and the posts that marked the safe way over stood shin-deep and patient. She stopped where the tarmac ended and watched them.

"Patient" is the one addition. It gives the posts the island's attitude to time, which your grandmother line picks up in the next paragraph. Cut it if it feels like too much on the first page.`,
      },
    ],
  },

  /* 7. Motive and consistency, grounded in the character bible and outline. */
  {
    key: 'motive',
    notebook: 'novel',
    title: "Is Mara's motive consistent?",
    daysAgo: 12,
    hour: 21,
    head: 'a2',
    messages: [
      {
        k: 'u1',
        p: null,
        role: 'user',
        at: 0,
        text: "Read the character bible and the outline together. Is Mara's motive consistent from the first chapter to the ending?",
      },
      {
        k: 'a1',
        p: 'u1',
        role: 'assistant',
        model: 'opus',
        at: 2,
        cites: {
          1: [
            'bible',
            'she believes her grandfather drowning was not an accident wants the truth more than the cottage',
          ],
          2: ['ch1', 'a matter concerning the boundary of the salt pans'],
          3: ['outline', 'Mara refuses without knowing why'],
          4: ['outline', 'Ending Mara does not sell stays through one winter'],
        },
        text: `Mostly yes, with one gap in act one.

**The motive as written.** The bible says Mara believes her grandfather's drowning was not an accident, and that she wants the truth more than the cottage, telling herself she will sell [1]. That is a strong engine, and the ending pays it off.

**The gap.** Chapter one never plants the suspicion. Mara comes because of the solicitor's letter about the boundary of the salt pans [2], and nothing on the page suggests she already doubts the drowning. Then in act one she refuses Eleanor's offer "without knowing why" [3]. A reader who has not seen the bible will read that as stubbornness rather than motive.

**The ending** works because it turns her motive: she came for the truth, intending to sell, and stays [4]. That turn only lands if the reader knew she meant to leave.

**A fix that costs one paragraph.** In chapter one, let her remember the night her grandfather drowned and one detail that never sat right, and have her think plainly that she will sell. Both halves of the motive are then on the page before the refusal.`,
      },
      {
        k: 'u2',
        p: 'a1',
        role: 'user',
        at: 9,
        text: 'What detail could she remember that never sat right, without giving away the moved posts?',
      },
      {
        k: 'a2',
        p: 'u2',
        role: 'assistant',
        model: 'opus',
        at: 10,
        cites: { 1: ['bible', 'tide times follow real tables for 1998'] },
        text: `Three options, from subtlest to strongest:

1. **The lamp.** Her grandfather always hung a storm lamp on the last causeway post when he crossed after dark. The night he drowned, it was found hanging on the wrong post. Nobody could say who moved it. (This rhymes with the moved posts without explaining them.)
2. **The tide table.** He crossed with two hours of safe water to spare by the printed tables, and he had crossed that causeway for forty years. Your rule that tide times follow real 1998 tables [1] lets a careful reader check it.
3. **The boots.** He was found without his boots, which he only ever took off to wade the salt pan sluice. Why was he at the sluice?

I would use the tide table. It is the most Mara-like detail, numerical and checkable, and it makes her profession part of her suspicion.`,
      },
    ],
  },

  /* 8. Expenses: sealed by a fact-check. */
  {
    key: 'expenses',
    notebook: 'tax',
    title: 'Which of my expenses can I claim?',
    daysAgo: 16,
    hour: 11,
    head: 'a1',
    messages: [
      {
        k: 'u1',
        p: null,
        role: 'user',
        at: 0,
        text: 'Go through the ledger and tell me which expenses I can claim, and how much.',
      },
      {
        k: 'a1',
        p: 'u1',
        role: 'assistant',
        model: 'sonnet',
        at: 1,
        cites: {
          1: ['hmrc', 'wholly and exclusively for the business business share'],
          2: ['ruth', 'Pret lunch meals only allowable when travelling'],
          3: ['ruth', 'MacBook 90% business use keep a note of why'],
          4: ['ruth', 'flat rate £26 a month 120 hours'],
        },
        text: `Almost everything goes in, with three adjustments.

**Claim in full.** Software, materials, the drawing tablet, travel to clients, postage, insurance, the desk lamp and the accountant's fee are all wholly for the business [1].

**Claim in part.** Broadband at 40% (£19.20 of £48.00) and the MacBook at 90% (£1,709.10 of £1,899.00).

**Leave out.** The Pret lunch. Meals are only allowable when you are travelling away from your normal place of work, and you were at home [2].

| | Amount |
|---|---|
| Claimed in full | £1,768.92 |
| Broadband, 40% | £19.20 |
| MacBook, 90% | £1,709.10 |
| **Total from the ledger** | **£3,497.22** |

Two notes. Keep a short written reason for the 90% on the MacBook, because HMRC do ask [3]. And add working from home on top of this: at about 120 hours a month, the flat rate is £26 a month, £312 for the year [4].`,
      },
    ],
    factchecks: [
      {
        message: 'a1',
        verifier: 'gpt',
        claims: [
          {
            text: 'Meals are only allowable when you are travelling away from your normal place of work',
            importance: 1,
            verdict: 'supported',
            evidence: [
              ['ruth', 'Meals are only allowable when you are travelling away', 'supports', 0.96],
              ['hmrc', 'Not allowable everyday meals usual place of work', 'supports', 0.83],
            ],
            rationale: 'Both the accountant and the HMRC notes say this.',
          },
          {
            text: 'at about 120 hours a month, the flat rate is £26 a month',
            importance: 0.9,
            verdict: 'supported',
            evidence: [
              ['ruth', 'flat rate would be £26 a month 120 hours', 'supports', 0.95],
              ['hmrc', '£26 for 101 hours or more', 'supports', 0.88],
            ],
            rationale: '120 hours falls in the 101-hours-or-more band, which is £26 a month.',
          },
        ],
      },
    ],
  },

  /* 9. Payments on account, yesterday, with a draft left in the composer. */
  {
    key: 'poa',
    notebook: 'tax',
    title: 'Payments on account for January',
    daysAgo: 1,
    hour: 16,
    head: 'a1',
    draft: 'Can I ask HMRC to reduce the payments on account if I expect a quieter year? ',
    messages: [
      {
        k: 'u1',
        p: null,
        role: 'user',
        at: 0,
        text: 'Ruth mentioned payments on account. How much do I need to have ready for 31 January, all in?',
      },
      {
        k: 'a1',
        p: 'u1',
        role: 'assistant',
        model: 'sonnet',
        at: 1,
        cites: {
          1: ['ruth', 'tax and Class 4 National Insurance roughly £8,900 payments on account £4,450'],
          2: ['hmrc', 'payments on account half of this year bill due 31 January and 31 July'],
        },
        text: `Plan for about **£13,350 on 31 January 2027**, then £4,450 on 31 July.

Ruth puts this year's tax and Class 4 National Insurance at roughly £8,900 [1]. Because that is over £1,000, you also start paying towards next year in advance: two payments on account, each half of this year's bill, due 31 January and 31 July [2].

| Due | What | Amount |
|---|---|---|
| 31 January 2027 | Balancing payment for 2025 to 26 | £8,900 |
| 31 January 2027 | First payment on account for 2026 to 27 | £4,450 |
| 31 July 2027 | Second payment on account | £4,450 |

January is the heavy one because it is the first year of payments on account. From next year, the January bill is only the balance for the year plus the first payment on account for the next.`,
      },
    ],
  },

  /* 10. A script, with a real tool call: pinned. */
  {
    key: 'scans',
    notebook: null,
    title: 'Rename scanned receipts by date',
    daysAgo: 6,
    hour: 10,
    pinned: true,
    head: 'a2',
    messages: [
      {
        k: 'u1',
        p: null,
        role: 'user',
        at: 0,
        text: 'I have a folder of scanned receipts called things like scan_0042.pdf. Write me a Python script that renames each one by the date in its file metadata, like 2025-06-21_scan_0042.pdf.',
      },
      {
        k: 'a1',
        p: 'u1',
        role: 'assistant',
        model: 'sonnet',
        at: 1,
        tools: [
          {
            tool: 'fs_list',
            args: { path: '/workspace/receipts' },
            ok: true,
            result: {
              path: '/workspace/receipts',
              entries: ['scan_0040.pdf', 'scan_0041.pdf', 'scan_0042.pdf', 'scan_0043.pdf', 'README.txt'],
            },
          },
        ],
        text: `I looked at \`receipts/\` first: four scans and a README, so the script should skip anything that isn't a PDF.

\`\`\`python
from datetime import datetime
from pathlib import Path


def rename_by_date(folder: Path, dry_run: bool = True) -> None:
    for pdf in sorted(folder.glob("scan_*.pdf")):
        taken = datetime.fromtimestamp(pdf.stat().st_mtime)
        target = pdf.with_name(f"{taken:%Y-%m-%d}_{pdf.name}")
        if target.exists():
            print(f"skip {pdf.name}: {target.name} already exists")
            continue
        print(f"{pdf.name} -> {target.name}")
        if not dry_run:
            pdf.rename(target)


if __name__ == "__main__":
    rename_by_date(Path("receipts"), dry_run=True)
\`\`\`

It runs as a dry run first and prints what it would do. Change \`dry_run=True\` to \`False\` when the list looks right.

One caveat: this uses the file's modified time, which is usually when it was scanned, not the date on the receipt.`,
      },
      {
        k: 'u2',
        p: 'a1',
        role: 'user',
        at: 9,
        text: 'It printed nothing on my Windows machine. The folder is on the D drive.',
      },
      {
        k: 'a2',
        p: 'u2',
        role: 'assistant',
        model: 'sonnet',
        at: 10,
        text: `That will be the path. \`Path("receipts")\` is relative to wherever you ran the script from, so on Windows it was probably looking in your home folder and finding nothing.

Pass the full path, and use a raw string so the backslashes are left alone:

\`\`\`python
if __name__ == "__main__":
    folder = Path(r"D:\\Scans\\receipts")
    if not folder.is_dir():
        raise SystemExit(f"No folder at {folder}")
    rename_by_date(folder, dry_run=True)
\`\`\`

The \`is_dir()\` check means a wrong path now fails loudly instead of silently printing nothing.`,
      },
    ],
  },

  /* 11. A weekend away: archived. */
  {
    key: 'peaks',
    notebook: null,
    title: 'A weekend in the Peak District',
    daysAgo: 20,
    hour: 18,
    archived: true,
    head: 'a1',
    messages: [
      {
        k: 'u1',
        p: null,
        role: 'user',
        at: 0,
        text: 'Plan a relaxed weekend in the Peak District for two, travelling by train from Leeds. One proper walk, good food, no car.',
      },
      {
        k: 'a1',
        p: 'u1',
        role: 'assistant',
        model: 'haiku',
        at: 1,
        text: `**Base yourselves in Edale or Hathersage.** Both are on the Hope Valley line, about 90 minutes from Leeds with one change in Sheffield.

**Saturday**
- Morning train to Edale.
- Walk: up Grindsbrook Clough to Kinder Scout's edge, round to Jacob's Ladder and back down the Vale of Edale. About 14 km and 5 hours with stops. Take waterproofs whatever the forecast says.
- Evening: a pint at the Old Nag's Head, then dinner.

**Sunday**
- Train two stops to Hathersage. Coffee and a bun at the outdoor swimming pool café.
- Short walk up to Stanage Edge for the view, about 2 hours there and back.
- Lunch in the village, then the afternoon train home.

**Booking**
- Book rooms early for weekends from May to September.
- Check engineering works on the Hope Valley line before you travel; Sunday services are less frequent.`,
      },
    ],
  },

  /* 12. A quick one today. */
  {
    key: 'regex',
    notebook: null,
    title: 'Regex for UK postcodes',
    daysAgo: 0,
    hour: 11,
    head: 'a1',
    messages: [
      {
        k: 'u1',
        p: null,
        role: 'user',
        at: 0,
        text: 'I need a regex to validate UK postcodes in a sign-up form. Pragmatic, not perfect.',
      },
      {
        k: 'a1',
        p: 'u1',
        role: 'assistant',
        model: 'haiku',
        at: 1,
        text: `This accepts every real format and is easy to read:

\`\`\`ts
const UK_POSTCODE = /^([A-Z]{1,2}\\d[A-Z\\d]?) ?(\\d[A-Z]{2})$/i;

export function normalisePostcode(input: string): string | null {
  const m = UK_POSTCODE.exec(input.trim());
  return m ? \`\${m[1]} \${m[2]}\`.toUpperCase() : null;
}
\`\`\`

\`normalisePostcode("ls61aa")\` returns \`"LS6 1AA"\`, so you can store one canonical form.

It will also accept a few combinations that are not real postcodes. For a sign-up form that is the right trade-off; if you need certainty, check against a postcode lookup at the point you need the address.`,
      },
    ],
  },
];

/* ---- Memory -------------------------------------------------------------------- */

export const MEMORY = {
  user: {
    Preferences: [
      ['Prefers tables when comparing options side by side.', 0.92, 14],
      ['Uses metric units, and pounds sterling for money.', 0.9, 18],
      ['Wants the recommendation first, then the reasons.', 0.88, 6],
    ],
    Writing: [['Likes short paragraphs in prose rather than bullet lists.', 0.86, 9, 'supersedes']],
    Code: [['Writes Python with type hints and pathlib, not os.path.', 0.9, 6]],
    Superseded: [['Prefers bullet-point summaries at the end of answers.', 21]],
  },
  projects: {
    launch: {
      Goal: ['Launch Fernway 2.0 on 18 November with Calm Routes as the headline feature.'],
      Decisions: [
        'Plus is £4.99 a month or £39.99 a year; the store page leads with the annual price.',
        'The launch offer is a 30-day free trial of Plus, not a discount.',
      ],
      Findings: [
        'Annual take-up depends more on which price is shown first than on the size of the discount (46% against 22%).',
        'The load test is the critical path: the Apple submission on 10 November depends on it.',
      ],
      'Open questions': ['Will finance accept £39.99 annual, or push for £44.99?'],
    },
    heat: {
      Goal: ['Replace the gas combination boiler with an air-source heat pump before next winter.'],
      Decisions: ['Size for 9 kW and commission at a 50 °C flow with weather compensation.'],
      Findings: [
        'Design heat loss is 8.4 kW; floor insulation would save about 1.2 kW.',
        'Brightwater is the only quote that matches the survey on unit size, radiators and insulation.',
      ],
      'Open questions': ['Underfloor heating downstairs, or four new radiators?'],
    },
    novel: {
      Goal: ['Finish a full second draft of The Salt Road by the end of January.'],
      Decisions: ["Plant Mara's suspicion in chapter one through the 1998 tide table."],
      Findings: ['The opening reads better as two sentences, with the posts "shin-deep".'],
      'Open questions': ['Does Callum learn about the tin box before or after the midpoint?'],
    },
    tax: {
      Goal: ['File the 2025 to 26 Self Assessment early and without surprises.'],
      Decisions: ['Use the £26 a month flat rate for working from home.'],
      Findings: ['Expect about £13,350 due on 31 January 2027, including the first payment on account.'],
      'Open questions': ['Was there a second invoice for the Bologna commission?'],
    },
  },
  failures: {
    'FAILURES/windows-paths.md': {
      title: 'Windows paths',
      lessons: [
        '**Script found no files on Windows.** Symptom: a Python script printed nothing. Cause: a relative path resolved against the wrong working directory. Fix: pass an absolute raw-string path and fail loudly with `is_dir()`. Recognise: silent empty output from a glob on Windows.',
      ],
    },
    'FAILURES/csv-encoding.md': {
      title: 'CSV encoding',
      lessons: [
        '**Pound signs turned into Â£ in an imported CSV.** Symptom: garbled currency symbols. Cause: the file was exported from Excel as UTF-8 with a byte-order mark and read as cp1252. Fix: open with `encoding="utf-8-sig"`. Recognise: Â before £ or € in the first rows.',
      ],
    },
  },
  models: {
    'MODELS/google__gemini-3-pro.md': {
      title: 'Gemini 3 Pro',
      quirks: [
        'Adds headings to short answers; ask for plain paragraphs when the answer is under 200 words.',
      ],
    },
  },
};

export const PROPOSALS = [
  {
    kind: 'preference',
    target: 'USER.md',
    section: 'Preferences',
    text: 'Show prices including VAT unless told otherwise.',
    rationale:
      'In "Compare the three installer quotes" you asked to see prices after the grant and checked whether VAT was included.',
    confidence: 0.72,
    provenance: 'user_message',
    thread: 'quotes',
    message: 'u1',
    hoursAgo: 46,
  },
  {
    kind: 'project_finding',
    target: 'PROJECTS/heat-pump-for-elm-grove.md',
    section: 'Decisions',
    text: 'Choose a Vaillant heat pump for reliability.',
    rationale:
      'Found in an installer quote document, not in anything you wrote. It can only be suggested, never saved on its own.',
    confidence: 0.58,
    provenance: 'source_content',
    thread: 'quotes',
    message: 'a1',
    hoursAgo: 45,
  },
];

export const NOTES = [
  {
    notebook: 'launch',
    title: 'Launch-day checklist',
    kind: 'human',
    daysAgo: 2,
    pinned: true,
    content: `- 06:30 final check of the store listings
- 07:00 embargo lifts; newsletter and in-app message go together
- 07:15 post on Instagram and Strava
- 09:00 support stand-up: watch for "why is my route slower" tickets
- 17:00 first-day numbers to the team`,
  },
  {
    notebook: 'launch',
    fromThread: 'pricing',
    fromMessage: 'a3',
    title: 'Help centre: plans and prices',
    daysAgo: 3,
  },
  {
    notebook: 'heat',
    title: 'Questions for installers',
    kind: 'human',
    daysAgo: 4,
    content: `1. What flow temperature will you commission at, and is weather compensation set up?
2. Where exactly will the outdoor unit go, and what is the noise at number 12's window?
3. Who applies for the Boiler Upgrade Scheme voucher, and when?
4. What happens if the install slips past the voucher's expiry?`,
  },
  {
    notebook: 'novel',
    title: 'Things the island knows',
    kind: 'human',
    daysAgo: 11,
    content: `The causeway is safe for about five hours either side of low water. Locals never say "the mainland", only "over the way". The Ship's landlord keeps the tide tables pinned behind the bar, annotated in pencil.`,
  },
  { notebook: 'tax', fromThread: 'expenses', fromMessage: 'a1', title: 'Expenses I can claim', daysAgo: 16 },
];

export const GRANTS = [
  { action: 'fs.write', resource: 'fs:/workspace/notes/**', scope: 'workspace', uses: 4, daysAgo: 10 },
  { action: 'http.get', resource: 'http:www.gov.uk/**', scope: 'always', uses: 7, daysAgo: 15 },
  { action: 'web.search', resource: '*', scope: 'notebook', notebook: 'heat', uses: 3, daysAgo: 8 },
  { action: 'shell.exec', resource: '*', scope: 'always', effect: 'deny', uses: 1, daysAgo: 18 },
];

export const DECISIONS = [
  { action: 'fs.list', resource: 'fs:/workspace/receipts', tier: 'auto', outcome: 'auto', daysAgo: 6 },
  {
    action: 'fs.read',
    resource: 'fs:/workspace/receipts/README.txt',
    tier: 'auto',
    outcome: 'auto',
    daysAgo: 6,
  },
  {
    action: 'fs.write',
    resource: 'fs:/workspace/notes/expenses.md',
    tier: 'gated',
    outcome: 'approved',
    daysAgo: 10,
  },
  {
    action: 'fs.write',
    resource: 'fs:/workspace/notes/heat-questions.md',
    tier: 'gated',
    outcome: 'grant',
    grant: 0,
    daysAgo: 4,
  },
  {
    action: 'http.get',
    resource: 'http:www.gov.uk/boiler-upgrade-scheme',
    tier: 'gated',
    outcome: 'approved',
    daysAgo: 15,
  },
  {
    action: 'http.get',
    resource: 'http:www.gov.uk/simpler-income-tax-simplified-expenses',
    tier: 'gated',
    outcome: 'grant',
    grant: 1,
    daysAgo: 14,
  },
  {
    action: 'fs.delete',
    resource: 'fs:/workspace/receipts/scan_0040.pdf',
    tier: 'critical',
    outcome: 'denied',
    daysAgo: 6,
  },
  {
    action: 'shell.exec',
    resource: 'shell:python rename.py',
    tier: 'critical',
    outcome: 'grant',
    grant: 3,
    daysAgo: 6,
  },
  {
    action: 'web.search',
    resource: 'web:heat pump noise limits',
    tier: 'gated',
    outcome: 'expired',
    daysAgo: 8,
  },
];

export const NOTIFICATIONS = [
  {
    kind: 'source',
    level: 'success',
    title: 'Installer quotes compared is ready',
    body: '12 passages, searchable now.',
    hoursAgo: 49,
  },
  {
    kind: 'memory',
    level: 'info',
    title: 'Remembered: prefers tables when comparing options',
    body: 'Saved to USER.md. Undo from Admin → Memory.',
    hoursAgo: 30,
  },
  {
    kind: 'health',
    level: 'warn',
    title: 'Knowledge restarted',
    body: 'It stopped answering for 12 s and came back on its own.',
    hoursAgo: 20,
    read: true,
  },
  {
    kind: 'factcheck',
    level: 'warn',
    title: 'A claim in "How big a heat pump do we need?" was contradicted',
    body: 'The voucher lasts three months, not six.',
    hoursAgo: 118,
  },
];
