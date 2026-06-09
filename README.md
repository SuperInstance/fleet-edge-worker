# fleet-edge-worker

Cloudflare Worker for SuperInstance fleet coordination at the edge.

Routes vessel bottles, dispatches actions to fleet agents, and serves fleet status — all from Cloudflare's global network.

## Architecture

```
HTTP Request → Router → Action Registry → Bottle → KV + R2 → Agent Poll
                                                     ↓
                                              WebSocket (Durable Object)
```

**Conservation law enforced**: every action in = exactly one bottle out (γ + η = C). No action is lost, no bottle is duplicated.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/dispatch` | Dispatch a fleet action → creates a bottle |
| `GET` | `/status` | Fleet status, metrics, agent count |
| `GET` | `/agents` | List all registered fleet agents |
| `GET` | `/actions` | List all registered actions |
| `GET` | `/bottles/:agent` | Poll an agent's bottle inbox |
| `PUT` | `/bottles/:id` | Confirm bottle delivery/consumption |
| `GET` | `/health` | Health check |

## Dispatch Example

```bash
curl -X POST https://fleet-edge.workers.dev/dispatch \
  -H "Content-Type: application/json" \
  -d '{
    "action": "chord_request",
    "payload": { "notes": ["C4", "E4", "G4"], "velocity": 100 }
  }'
```

Response:
```json
{
  "ok": true,
  "bottle": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "target": "fleet-midi/chord",
    "action": "chord_request",
    "status": "outgoing"
  },
  "dispatched_at": 1717948800000
}
```

## Registered Agents

| Agent | Port | Capabilities |
|-------|------|-------------|
| fleet-midi | 8101 | chord, fx, melody, rhythm |
| ghost-track | 8102 | accompaniment, variation |
| persona-engine | 8103 | persona, voice |
| fleet-conductor | 8104 | conduct, schedule, tempo |
| forgemaster | 8105 | forge, build, compile |
| oracle2 | 8106 | infer, voice-to-midi |
| construct | 8107 | coordinate, dispatch |

## Storage

- **KV** (`FLEET_KV`): Bottle routing, inbox indices, daily metrics (auto-expiring)
- **R2** (`VESSELS`): Durable bottle log (persistent archive)
- **Durable Object** (`AgentHub`): WebSocket hub for real-time agent notifications

## Development

```bash
npm install
npm run dev     # Local dev server
npm test        # Run tests
npm run deploy  # Deploy to Cloudflare
```

## Integration with I2I Dispatcher

This worker is the **edge counterpart** to the local `i2iDispatcher.ts`:
- Local dispatcher → writes bottles to `/tmp/i2i-vessel/` for local agents
- Edge worker → writes bottles to KV/R2 for remote agents and public API

Both share the same action registry and bottle format. The 16 actions and 7 agents are mirrored.

## License

MIT OR Apache-2.0
