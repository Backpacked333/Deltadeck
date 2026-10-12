import type { CaseRecord, Question } from '../core/types'
import type { SkillId } from './types'

export const skills = {
  incremental: {
    title: 'Incremental outcomes',
    prerequisite: null,
    error: 'gross-as-net',
    hypothesis:
      'You may be counting returned stake as gain. A cash-flow question without probability can distinguish this from an EV calculation error.',
  },
  conditioning: {
    title: 'Conditioning and event definition',
    prerequisite: 'incremental',
    error: 'wrong-denominator',
    hypothesis:
      'You may be keeping the original denominator after new information. A sample-space diagnostic can distinguish this from arithmetic.',
  },
  thresholds: {
    title: 'Expected value and thresholds',
    prerequisite: 'incremental',
    error: 'threshold-setup',
    hypothesis:
      'You may be averaging receipts instead of incremental outcomes. A threshold diagnostic can distinguish payoff setup from probability assumptions.',
  },
} as const
export interface LearningTask {
  case: CaseRecord
  skill: SkillId
  family: string
  context: 'poker' | 'business' | 'everyday'
  purpose:
    | 'worked'
    | 'fading'
    | 'diagnostic'
    | 'independent'
    | 'transfer'
    | 'delayed'
  holdout: boolean
  minutes: number
}
function number(
  id: string,
  prompt: string,
  expected: number,
  explanation: string,
): Question {
  return {
    id,
    prompt,
    expected,
    kind: 'numeric',
    tolerance: 0.000001,
    units: 'stated units',
    component: 'setup',
    critical: true,
    points: 1,
    rationale: explanation,
    hints: [
      'Write only the information supplied before the decision.',
      'List the relevant outcomes and their denominator.',
      explanation,
      `Model answer: ${expected}.`,
    ],
  }
}
function task(
  skill: SkillId,
  slug: string,
  purpose: LearningTask['purpose'],
  context: LearningTask['context'],
  title: string,
  information: string[],
  questions: Question[],
  explanation: string[],
): LearningTask {
  const id = `targeted-${skill}-${slug}`
  const complete = questions.map((q, index) => ({
    ...q,
    component: index === 0 ? ('setup' as const) : ('calculation' as const),
  }))
  if (complete.length === 1 && complete[0].kind === 'numeric')
    complete.push({
      ...number(
        'frequency',
        'Expected target events per 100 draws under the same conditioning?',
        complete[0].expected * 100,
        'Multiply the conditional probability by 100.',
      ),
      component: 'calculation',
    } as (typeof complete)[number])
  const conceptual: Question[] = [
    {
      id: 'meaning',
      kind: 'choice',
      component: 'interpretation',
      points: 1,
      critical: true,
      prompt: 'What does the answer establish?',
      expected: 'conditional',
      options: [
        {
          id: 'conditional',
          label: 'The stated quantity under the model’s conditions',
          rationale: 'Correct: the conditions define the answer.',
        },
        {
          id: 'guarantee',
          label: 'A guaranteed realized result in the next case',
          rationale: 'A model does not guarantee a realized result.',
        },
      ],
      rationale:
        'An outcome or expectation is conditional on the stipulated model.',
      hints: [
        'Separate models from outcomes.',
        'The question specifies assumptions.',
        'Future realized outcomes may vary.',
        'Choose the model-conditional quantity.',
      ],
    },
    {
      id: 'limit',
      kind: 'choice',
      component: 'limitation',
      points: 1,
      critical: true,
      prompt: 'Which change requires rebuilding this calculation?',
      expected: 'assumption',
      options: [
        {
          id: 'label',
          label: 'Renaming the decision maker only',
          rationale: 'A label alone does not change the decision.',
        },
        {
          id: 'assumption',
          label: 'Changing the relevant future payments or conditional event',
          rationale: 'Correct: this changes what the calculation describes.',
        },
      ],
      rationale:
        'A changed payoff or event definition changes the model, not just its label.',
      hints: [
        'Look for decision-relevant information.',
        'Names do not alter outcomes.',
        'Payments and conditional events do.',
        'Rebuild when a relevant assumption changes.',
      ],
    },
  ]
  return {
    skill,
    family: id,
    context,
    purpose,
    holdout: purpose === 'delayed',
    minutes: purpose === 'worked' ? 2 : 4,
    case: {
      id,
      familyId: id,
      unitId:
        skill === 'incremental'
          ? 'f01'
          : skill === 'conditioning'
            ? 'f02'
            : 'f03',
      contentVersion: 1,
      rubricVersion: 1,
      title,
      role: 'Decision maker before the outcome',
      objective: skills[skill].title,
      information,
      states: ['The stated possible outcomes'],
      actions: ['Commit an answer before feedback'],
      responses: 'No hidden response or future outcome is supplied.',
      cashFlows:
        'Use only the stated future payments and receipts; prior payments are sunk.',
      constraints:
        'No borrowing, tax or discounting; all stated receipts are enforceable.',
      assumptions: [
        'Stylized educational model; not an investing recommendation.',
        'All probabilities are stipulated, not inferred from realized wins.',
      ],
      connection: context === 'poker' ? 'direct' : 'separate-finance',
      mode:
        purpose === 'delayed'
          ? 'review'
          : purpose === 'transfer' ||
              purpose === 'independent' ||
              purpose === 'diagnostic'
            ? 'transfer'
            : purpose === 'fading'
              ? 'partial'
              : 'worked',
      questions: [...complete, ...conceptual],
      scaffold:
        purpose === 'fading'
          ? [
              'Separate each future payment from each receipt.',
              'Compute net outcomes before multiplying by probabilities.',
            ]
          : undefined,
      workedSolution: explanation,
      reflectionPrompt:
        'What assumption would reverse your answer? Prose is ungraded.',
      decisionReversal:
        'Change a future cost, conditional probability or receipt; do not use the realized outcome.',
      sources: [],
    },
  }
}
export const tasks: LearningTask[] = [
  task(
    'incremental',
    'ledger',
    'worked',
    'everyday',
    'Payments are not receipts',
    [
      'You paid 12 yesterday, non-refundable. Pay 20 now; success returns 65 including all returned funding, failure returns 5. Declining now returns 0.',
    ],
    [
      number(
        'net',
        'Incremental success net?',
        45,
        '65 receipts minus 20 new payment = 45.',
      ),
      number(
        'loss',
        'Incremental failure net?',
        -15,
        '5 salvage minus 20 = -15. The prior 12 is sunk.',
      ),
    ],
    [
      'Success: pay 20, receive 65, net +45.',
      'Failure: pay 20, recover 5, net -15.',
      'Yesterday’s 12 is unchanged by today’s action.',
    ],
  ),
  task(
    'incremental',
    'partial-ledger',
    'fading',
    'everyday',
    'Complete a return-and-refund ledger',
    [
      'A reservation fee of 9 was paid yesterday. Pay a balance of 30 today. Delivery returns goods worth 72; cancellation refunds 18 of today’s balance.',
    ],
    [
      number('net', 'Incremental delivery value?', 42, '72 - 30 = 42.'),
      number(
        'refund',
        'Incremental cancellation value?',
        -12,
        '18 - 30 = -12.',
      ),
    ],
    [
      'Separate reservation fee from today’s decision.',
      'Delivery +42; cancellation -12.',
    ],
  ),
  task(
    'incremental',
    'cash-diagnostic',
    'diagnostic',
    'everyday',
    'Cash flows before probabilities',
    [
      'Pay a refundable deposit of 25. If the service succeeds you receive your deposit plus a bonus of 10. If it fails your deposit alone is returned.',
    ],
    [
      number(
        'net',
        'Net gain on success?',
        10,
        '35 returned minus 25 paid = 10.',
      ),
      number(
        'loss',
        'Net gain on failure?',
        0,
        '25 returned minus 25 paid = 0.',
      ),
    ],
    ['Both paths return principal; only the bonus is gain.'],
  ),
  task(
    'incremental',
    'poker-call',
    'independent',
    'poker',
    'Unaided call ledger',
    [
      'The pot is 90 before your call of 30. Winning returns the entire 120 including your call; losing returns nothing. Earlier contributions are already in the pot.',
    ],
    [
      number(
        'net',
        'Incremental win net relative to folding now?',
        90,
        '120 - 30 = 90.',
      ),
      number('loss', 'Incremental loss net?', -30, '0 - 30 = -30.'),
    ],
    ['Win +90, lose -30; do not add the call to profit.'],
  ),
  task(
    'incremental',
    'business-inventory',
    'transfer',
    'business',
    'Fresh transfer: stock with salvage',
    [
      'A shop spent 40 on research. Order stock for 70 now. Strong demand produces sales of 150. Weak demand produces sales of 20 plus a supplier salvage payment of 15.',
    ],
    [
      number('net', 'Strong-demand incremental profit?', 80, '150 - 70 = 80.'),
      number(
        'loss',
        'Weak-demand incremental profit?',
        -35,
        '20 + 15 - 70 = -35.',
      ),
    ],
    ['Research is sunk. Strong +80; weak -35.'],
  ),
  task(
    'incremental',
    'delayed-warranty',
    'delayed',
    'business',
    'Reserved check: warranty obligations',
    [
      'Accept a job with an immediate fee of 100 and parts costing 35. On failure you must refund 60 and pay a technician 20; on success there are no later payments. A prior advertisement cost 15.',
    ],
    [
      number('net', 'Incremental profit on success?', 65, '100 - 35 = 65.'),
      number(
        'loss',
        'Incremental profit on failure?',
        -15,
        '100 - 35 - 60 - 20 = -15.',
      ),
    ],
    ['Account for contingent future liabilities, not only receipts.'],
  ),
  task(
    'conditioning',
    'sample-space',
    'worked',
    'everyday',
    'The denominator changes',
    [
      'A bag has 4 red and 6 blue tokens. Two blue tokens are removed and shown before you draw uniformly from the rest.',
    ],
    [
      number(
        'probability',
        'Probability of red after removal?',
        0.5,
        '4 of the remaining 8 are red.',
      ),
    ],
    ['Condition on the observed removal: 4/(4+4)=1/2.'],
  ),
  task(
    'conditioning',
    'partial-space',
    'fading',
    'everyday',
    'Filter before counting',
    [
      'Among 100 packages, 20 are fragile. A scanner flags 16 fragile and 24 non-fragile packages. You receive a flagged package.',
    ],
    [
      number(
        'probability',
        'Probability your flagged package is fragile?',
        0.4,
        '16/(16+24)=.4, not 16/100.',
      ),
    ],
    ['Use only flagged packages as the denominator.'],
  ),
  task(
    'conditioning',
    'poker-event',
    'independent',
    'poker',
    'Improving is not winning',
    [
      'There are 20 equally likely possible next cards in this stipulated model. Six improve your hand, but only four of those win. Two cards that do not improve your hand also win. No ties.',
    ],
    [
      number('probability', 'Probability of winning?', 0.3, '(4+2)/20=.3.'),
      number(
        'conditional',
        'Probability of winning conditional on improving?',
        2 / 3,
        '4/6, not 6/20.',
      ),
    ],
    ['Define the event and the condition separately.'],
  ),
  task(
    'conditioning',
    'business-screen',
    'transfer',
    'business',
    'Fresh transfer: demand signal',
    [
      'Of 200 comparable periods, 80 had strong demand. An alert appeared in 60 strong and 40 weak periods. An alert is observed today; assume these frequencies describe today.',
    ],
    [
      number(
        'probability',
        'Strong demand given alert?',
        0.6,
        '60/(60+40)=.6.',
      ),
    ],
    ['Condition on the alert, not all periods.'],
  ),
  task(
    'conditioning',
    'delayed-quality',
    'delayed',
    'business',
    'Reserved check: sequential sampling',
    [
      'A sealed batch has 3 good components and 2 defective components. Draw two uniformly without replacement. You learn only that at least one of the two is defective, not which one.',
    ],
    [
      number(
        'probability',
        'Probability both drawn components are defective given this information?',
        1 / 7,
        'There are 10 unordered pairs, 3 all-good pairs and 1 all-defective pair. Condition on the 7 pairs that contain a defect.',
      ),
    ],
    [
      'This is a joint event under sampling without replacement, not a classifier or a one-draw rate.',
    ],
  ),
  task(
    'thresholds',
    'ev-ledger',
    'worked',
    'everyday',
    'Average net outcomes',
    [
      'A choice pays net +60 on success and -40 on failure. Success probability is .5; declining pays zero.',
    ],
    [
      number('ev', 'Expected net?', 10, '.5×60+.5×(-40)=10.'),
      number(
        'threshold',
        'Break-even success probability?',
        0.4,
        'p×60-(1-p)×40=0, so p=.4.',
      ),
    ],
    ['At .5 the choice has positive modeled EV, not a guaranteed profit.'],
  ),
  task(
    'thresholds',
    'partial-ev',
    'fading',
    'everyday',
    'Finish the threshold calculation',
    [
      'A repair offers net +90 if it works and -30 otherwise. Its success probability is .2.',
    ],
    [
      number('ev', 'Expected net?', -6, '.2×90-.8×30=-6.'),
      number('threshold', 'Break-even probability?', 0.25, '30/(90+30)=.25.'),
    ],
    ['Use losses with a minus sign.'],
  ),
  task(
    'thresholds',
    'poker-price',
    'independent',
    'poker',
    'Unaided call threshold',
    [
      'Call 20 to contest a pot of 80 before your call. You win with probability .25 and never tie. No later betting.',
    ],
    [
      number('ev', 'Incremental call EV?', 5, '.25×80-.75×20=5.'),
      number('threshold', 'Break-even win probability?', 0.2, '20/(80+20)=.2.'),
    ],
    ['Gross pot receipt is 100, incremental win is 80.'],
  ),
  task(
    'thresholds',
    'business-contract',
    'transfer',
    'business',
    'Fresh transfer: service contract',
    [
      'A fixed contract produces net +140 when equipment works and -60 when it fails. The success probability is .35; rejecting pays zero.',
    ],
    [
      number('ev', 'Expected net?', 10, '.35×140-.65×60=10.'),
      number(
        'threshold',
        'Break-even success probability?',
        0.3,
        '60/(140+60)=.3.',
      ),
    ],
    ['A lower success probability than .3 reverses the modeled choice.'],
  ),
  task(
    'thresholds',
    'delayed-capacity',
    'delayed',
    'business',
    'Reserved check: capacity choice',
    [
      'Choose exactly one contract. A pays net 15 for certain. B costs 30 now and returns 100 if demand is strong or 10 if weak. Strong demand probability is .25.',
    ],
    [
      number(
        'ev',
        'Expected advantage of B relative to A?',
        -12.5,
        'B nets +70 or -20, so its EV is 2.5. Subtract A’s 15: -12.5.',
      ),
      number(
        'threshold',
        'Strong-demand probability where B and A have equal expected value?',
        35 / 90,
        '70p-20(1-p)=15, so p=35/90. Beating zero is not enough.',
      ),
    ],
    [
      'Compare two active alternatives, including the opportunity cost, rather than a choice against zero.',
    ],
  ),
]
export const taskById = new Map(tasks.map((t) => [t.case.id, t]))
