# Where these executables come from

`install.sh` uploads this folder to the `mf6_bin` volume. The app and the jobs fetch from there; nothing is
downloaded from the internet at run time. All are unmodified upstream builds.

| Path | What | Source |
|---|---|---|
| `6.8.1/linux-x86_64/bin/mf6` | MODFLOW 6.8.1 (app container) | USGS release, github.com/MODFLOW-ORG/modflow6/releases (mf6.8.1_linux.zip) |
| `6.8.1/linux-aarch64/bin/mf6`, `lib/*` | MODFLOW 6.8.1 + Fortran runtime (serverless Spark executors are aarch64) | conda-forge `modflow6` 6.8.1, `libgfortran5` and `libgcc` 16.2 |
| `classic/linux-x86_64/{mf2005,mfnwt,mfusg,mf5to6,zbud6}` | MODFLOW-2005 1.12, MODFLOW-NWT, MODFLOW-USG 1.5, the MF2005-to-MF6 converter, ZoneBudget 6 | github.com/MODFLOW-ORG/executables release 29.0 (linux.zip) |
| `pestpp/linux-x86_64/pestpp-{glm,ies,sen}` | PEST++ 5.2.16 | github.com/pestpp/pestpp/releases/tag/5.2.16 (pestpp-5.2.16-linux.tar.gz) |

To use a different MODFLOW 6 version, replace the files under a new version folder and change `MF6_VERSION` in
`src/gwmodel.py`.
