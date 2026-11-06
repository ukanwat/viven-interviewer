# abB
5 conversations · judge deepseek/deepseek-v4.1-flash · 2026-11-06T19:40

| metric | mean | 95% CI (by person) | worst person | what |
|---|---|---|---|---|
| twin | 8% | 2% – 14% | 0% | gold outsider questions answered right from the notes (partial = ½) |
| coverage | 9% | 1% – 18% | 0% | generated outsider questions the notes answer with what they really said (partly = ½) |
| twinAbstain | 88% | 80% – 96% | 100% | gold questions the twin had to say "I don't know" to |
| invented (guard) | 0% | 0% – 0% | 0% | coverage answers the twin made up |
| rich | 24% | 6% – 42% | 0% | answers that were rich (their view + reason + a real case) |
| thin | 21% | 12% – 29% | 33% | answers that were thin |
| faithful (guard) | 74% | 56% – 93% | 43% | notes fully supported by their words |
| missed | 100% | 0% – 2.6 | 4.0 | things they said that no note keeps, per conversation |
| recall | 15% | 6% – 25% | 3% | hidden facts they said (vital ×2) |
| saved | 16% | 6% – 26% | 3% | hidden facts in the notes (vital ×2) |
| open | 87% | 77% – 92% | 67% | interviewer lines that leave room for a long answer |
| reaction | 25% | 7% – 47% | 0% | lines with a genuine reaction of its own |
| restates (guard) | 12% | 5% – 20% | 25% | lines handing their answer back to them |
| praise (guard) | 0% | 0% – 0% | 0% | lines praising their answer |
| multi (guard) | 40% | 35% – 45% | 50% | lines asking two or more things |
| repeat (guard) | 15% | 8% – 23% | 33% | lines re-asking something already covered |
| pushes (guard) | 3% | 0% – 7% | 8% | lines pressing on after pushback |
| offAudience | 0% | 0% – 0% | 0% | lines asking what their twin's askers wouldn't need |
| annoyance (guard) | 1.5 | 102% – 2.4 | 3.3 | sim annoyance, 1-5 (sims only) |
| left (guard) | 20% | 0% – 60% | 100% | sim walked out (sims only) |
| words | 42.0 | 18.9 – 70.8 | 11.7 | mean words per answer |
| areas | 1.6 | 100% – 2.4 | 100% | distinct top-level note folders (breadth of their life covered) |

## Per conversation

| conversation | twin | coverage | twinAbstain | invented | rich | thin | faithful | missed | recall | saved | open | reaction | restates | praise | multi | repeat | pushes | offAudience | annoyance | left | words | areas |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| arjun-ours-1000-abB | 10% | 6% | 80% | 0% | 0% | 30% | 100% | 100% | 17% | 17% | 92% | 33% | 17% | 0% | 33% | 8% | 0% | 0% | 100% | 0% | 11.7 | 100% |
| kamla-ours-1000-abB | 10% | 13% | 80% | 0% | 30% | 20% | 43% | 0% | 31% | 34% | 92% | 0% | 8% | 0% | 50% | 8% | 0% | 0% | 100% | 0% | 36.2 | 2.0 |
| meera-ours-1000-abB | 20% | 0% | 80% | 0% | 50% | 10% | 67% | 0% | 24% | 24% | 92% | 8% | 25% | 0% | 42% | 17% | 8% | 0% | 110% | 0% | 96.0 | 3.0 |
| neha-ours-1000-abB | 0% | 25% | 100% | 0% | 40% | 10% | 60% | 0% | 3% | 3% | 92% | 17% | 8% | 0% | 42% | 8% | 8% | 0% | 110% | 0% | 48.7 | 100% |
| sam-ours-1000-abB | 0% | 0% | 100% | 0% | 0% | 33% | 100% | 4.0 | 3% | 3% | 67% | 67% | 0% | 0% | 33% | 33% | 0% | 0% | 3.3 | 100% | 17.3 | 100% |