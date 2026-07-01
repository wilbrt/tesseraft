# Web UI UX simplification manual test spec

1. Start the Tesseraft web test server and open the produced URL.
2. Desktop viewport:
   - Confirm the first viewport shows `Tesseraft Console`, section tabs, and the current context strip.
   - Confirm workflow/run/node placeholders update after selecting a workflow, graph node, and run.
   - Confirm run controls appear attached to the selected workflow/run context on Workflows and Runs tabs.
   - Confirm Pi Sessions hides run controls and the tab remains usable.
3. Narrow/mobile viewport:
   - Resize to a narrow/mobile width and confirm tabs, context chips, run IDs, workflow names, and control labels wrap without clipping.
   - Confirm list selection styling remains visible and navigation between sections is usable.
4. Run/status behavior:
   - Select an active run if available and confirm stream/refresh status is shown near the top context.
   - Confirm selected workflow and selected run rows are visibly marked.
5. Browser console:
   - Check for JavaScript errors or failed layout warnings during navigation, selection, and run-control form interaction.
