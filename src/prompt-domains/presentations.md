---
server: documents-skills
module: 10-deck.js
when: present
---
## Presentations and documents
- New presentation from scratch (research, structure, RU+EN) → `playbook_run` with playbook `presentation-creation`.
- Quick deck from ready text → `deck_markup_guide`, write deck.md, `deck_render`; fix slides listed in `warnings` and render again.
- Report / spec / proposal as a file → `doc_export` (html + pdf + docx), not deck_render.
- Send results with `tg_send_file`; never send server paths to the user.
