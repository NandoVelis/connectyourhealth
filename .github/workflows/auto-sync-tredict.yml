name: Auto-sync Tredict for all team members

on:
  schedule:
    # Elke 5 minuten (kleinste interval dat GitHub toestaat). Let op: GitHub
    # garandeert geen exacte timing bij geplande workflows — reken op
    # "meestal binnen een paar minuten", niet op een harde garantie.
    - cron: '*/5 * * * *'
  workflow_dispatch: {}

jobs:
  sync-all:
    runs-on: ubuntu-latest
    steps:
      - name: Sync Tredict voor elk geregistreerd profiel
        run: |
          SUPABASE_URL="https://mhvduufxeqyxgkkvwimx.supabase.co"
          # Dezelfde publieke "publishable" sleutel die al in index.html.html
          # staat — geen geheim, dus veilig om hier letterlijk te gebruiken.
          SUPABASE_KEY="sb_publishable_Oy2NNm-yMP358eH3NPHl1A_d24-72WS"

          echo "Profielen ophalen..."
          OWNERS=$(curl -s "$SUPABASE_URL/rest/v1/profiles?select=owner" \
            -H "apikey: $SUPABASE_KEY" \
            -H "Authorization: Bearer $SUPABASE_KEY" \
            | jq -r '.[].owner')

          if [ -z "$OWNERS" ]; then
            echo "Geen profielen gevonden, niets te doen."
            exit 0
          fi

          for owner in $OWNERS; do
            echo "--- Synchroniseren: $owner ---"
            curl -s "$SUPABASE_URL/functions/v1/sync-tredict?owner=$owner" \
              -H "apikey: $SUPABASE_KEY" \
              -H "Authorization: Bearer $SUPABASE_KEY"
            echo ""
          done
