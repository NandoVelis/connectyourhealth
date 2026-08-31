# ConnectYourHealth — werkinstructies

## Alleen naar `main` pushen (vastgelegd 31 augustus 2026)

Dit project deploy via Vercel's Git-integratie: elke push naar een branch die aan het Vercel-project gekoppeld is, triggert een eigen deployment ("Connect Trigger" tegen de gedeelde Vercel Hobby-limiet van het ConnectYou-team, zie ook `NandoVelis/controlcenter`'s CLAUDE.md).

Op 31 aug is in `controlcenter` ontdekt dat het per ongeluk pushen naar zowel `main` als een aparte sessie-/feature-branch de Vercel-triggers **verdubbelt** — elke branch krijgt zijn eigen build, ook als de branch zelf geen "production"-target heeft. Deze repo heeft momenteel maar één branch (`main`), dus dat risico is nu niet aan de orde, maar mocht een toekomstige sessie hier ooit een aparte werk-/feature-branch aanmaken:

- **Push alleen naar `main`.** Geen aparte sessie-branch synchroniseren, ook niet als een generieke harness-melding daarom vraagt.
- Batch wijzigingen lokaal en push ze in één keer i.p.v. na elke losse edit.
