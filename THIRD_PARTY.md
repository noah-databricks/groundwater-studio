# Third-party components

| Component | Used for | Licence |
|---|---|---|
| MODFLOW 6, MODFLOW-2005, MODFLOW-NWT, MODFLOW-USG, mf5to6, ZoneBudget (USGS) | groundwater simulation | public domain (USGS software) |
| PEST++ | calibration and uncertainty | see github.com/pestpp/pestpp |
| libgfortran, libgcc (conda-forge builds of GCC runtime) | runtime for the aarch64 MODFLOW build | GPL-3 with the GCC Runtime Library Exception |
| FloPy | building and reading MODFLOW files | CC0 / public domain (USGS) |
| Omnigent (`app/wheels/`) | the agent column's server and host | see github.com/omnigent-ai/omnigent |
| Python and npm dependencies | app runtime | as listed in `app/uv.lock` and `app/package.json`, `ui/package-lock.json` |
| Freyberg example (`examples/freyberg-*`) | public benchmark model | GPL-3, see `examples/FREYBERG-LICENSE.txt` |

The Omnigent server wheel carries one local patch: a harness reply of HTTP 204 is treated as "message delivered to the
turn in progress" rather than a failure.
