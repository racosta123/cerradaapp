# tools/ — pruebas contra Firestore REAL (solo cerrada TEST-001)

Scripts de la fase de prueba de la fusión que preserva credenciales. Golpean el Worker de producción,
pero **solo escriben en la cerrada de prueba `TEST-001`** (datos ficticios); abortan si el código es otro.
No contienen datos de ninguna cerrada real.

| Script | Qué hace |
|---|---|
| `test001_setup.mjs` | Crea TEST-001 (3 casas, 1 familiar, admin) usando solo la API del Worker. Si ya existe, no hace nada. |
| `test001_run.mjs`   | Secuencia a–e: push "malo" sin PIN, credenciales forjadas, copia vieja, familiar inyectado, borrados con `removed`, `/admin/set-pin`, `/admin/change-pin` e ids inmutables. Restaura los PIN al terminar. |

```
node tools/test001_setup.mjs
node tools/test001_run.mjs
```

Requiere que `FS_ENFORCE_CODES` (en `wrangler.toml`) incluya `TEST-001`. Las pruebas offline
(sin red) están en `fs_merge.test.mjs` y `worker_fs.integration.test.mjs`:
`node --test fs_merge.test.mjs worker_fs.integration.test.mjs`.
