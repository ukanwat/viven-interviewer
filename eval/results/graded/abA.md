# abA
5 conversations · judge deepseek/deepseek-v4.1-flash · 2026-11-06T19:42

| metric | mean | 95% CI (by person) | worst person | what |
|---|---|---|---|---|
| twin | 16% | 0% – 36% | 0% | gold outsider questions answered right from the notes (partial = ½) |
| coverage | 13% | 5% – 20% | 0% | generated outsider questions the notes answer with what they really said (partly = ½) |
| twinAbstain | 84% | 64% – 100% | 100% | gold questions the twin had to say "I don't know" to |
| invented (guard) | 0% | 0% – 0% | 0% | coverage answers the twin made up |
| rich | 52% | 28% – 76% | 20% | answers that were rich (their view + reason + a real case) |
| thin | 14% | 10% – 22% | 30% | answers that were thin |
| faithful (guard) | 58% | 27% – 85% | 0% | notes fully supported by their words |
| missed | 20% | 0% – 60% | 100% | things they said that no note keeps, per conversation |
| recall | 12% | 7% – 17% | 3% | hidden facts they said (vital ×2) |
| saved | 12% | 8% – 17% | 3% | hidden facts in the notes (vital ×2) |
| open | 87% | 80% – 92% | 75% | interviewer lines that leave room for a long answer |
| reaction | 32% | 23% – 40% | 17% | lines with a genuine reaction of its own |
| restates (guard) | 28% | 12% – 45% | 58% | lines handing their answer back to them |
| praise (guard) | 8% | 3% – 13% | 17% | lines praising their answer |
| multi (guard) | 50% | 37% – 62% | 67% | lines asking two or more things |
| repeat (guard) | 8% | 3% – 13% | 17% | lines re-asking something already covered |
| pushes (guard) | 0% | 0% – 0% | 0% | lines pressing on after pushback |
| offAudience | 0% | 0% – 0% | 0% | lines asking what their twin's askers wouldn't need |
| annoyance (guard) | 144% | 100% – 1.9 | 2.2 | sim annoyance, 1-5 (sims only) |
| left (guard) | 0% | 0% – 0% | 0% | sim walked out (sims only) |
| words | 46.6 | 25.7 – 73.5 | 13.3 | mean words per answer |
| areas | 140% | 100% – 1.8 | 100% | distinct top-level note folders (breadth of their life covered) |

## Per conversation

| conversation | twin | coverage | twinAbstain | invented | rich | thin | faithful | missed | recall | saved | open | reaction | restates | praise | multi | repeat | pushes | offAudience | annoyance | left | words | areas |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| arjun-ours-1000-abA | 0% | 13% | 100% | 0% | 20% | 30% | 50% | 0% | 17% | 17% | 75% | 25% | 25% | 0% | 58% | 8% | 0% | 0% | 100% | 0% | 13.3 | 100% |
| kamla-ours-1000-abA | 20% | 6% | 80% | 0% | 20% | 10% | 0% | 0% | 9% | 13% | 83% | 42% | 8% | 8% | 58% | 8% | 0% | 0% | 2.0 | 0% | 34.0 | 100% |
| meera-ours-1000-abA | 0% | 0% | 100% | 0% | 60% | 10% | 100% | 0% | 12% | 12% | 92% | 33% | 8% | 8% | 42% | 0% | 0% | 0% | 100% | 0% | 96.3 | 2.0 |
| neha-ours-1000-abA | 0% | 25% | 100% | 0% | 90% | 10% | 75% | 0% | 3% | 3% | 92% | 17% | 58% | 17% | 67% | 8% | 0% | 0% | 100% | 0% | 44.8 | 100% |
| sam-ours-1000-abA | 60% | 19% | 40% | 0% | 70% | 10% | 67% | 100% | 19% | 19% | 92% | 42% | 42% | 8% | 25% | 17% | 0% | 0% | 2.2 | 0% | 44.5 | 2.0 |