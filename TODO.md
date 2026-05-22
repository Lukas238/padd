# TODO

## Confluence

- [ ] **Layout support** — agregar soporte para layouts de Confluence (2 columnas, section/column macros). Actualmente los bloques `<!--[CONFLUENCE]-->` permiten inyectar XML verbatim, pero layouts requieren estructura anidada que habría que modelar en markdown de alguna forma.
- [ ] **Macro shortcodes** - Agregar shorcodes de macros de confluences para markdown. Por ejemplo para agregar a mano [[short:child-support level=2]] o quiza [[short:status type=alert label="Work in progress"]].
- [ ] PADD as a tool nee  unit test to be able to check that any additional change or improve do not breake something backwards. Also as PADD will be a muti tool, now focused on Confluence but in the future will include Sharepoint, we need to take this into account to keep everithung modular and scalable.