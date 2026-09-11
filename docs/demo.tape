# ErgoLab demo tape — renders assets/ergolab-demo.gif.
#
# Drives the real built CLI through the grep arm of the bundled A/B pair
# with the deterministic mock agent plus one absent agent, so the gif
# shows both a filling panel and the skip contract (gemini-cli is not
# installed here; its row is kept as skipped, not dropped). Rebuild
# first (npm run build), then refresh with: vhs docs/demo.tape

Output assets/ergolab-demo.gif
Set Shell bash
Set FontSize 14
Set Width 1500
Set Height 820
Set TypingSpeed 150ms

Type "node dist/cli.js run suites/showcase-grep-vs-tool --agents mock,gemini-cli"
Sleep 500ms
Enter
# The run resolves the panel, executes the six tasks sequentially in
# fresh sandboxes, and prints the tables.
Sleep 6s
# Dwell on the failure table, the scorecard, and the written artifacts.
Sleep 14s
