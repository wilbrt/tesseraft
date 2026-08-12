# Windows quickstart

The supported Windows setup is Tesseraft inside Ubuntu on WSL 2. Tesseraft's
CLI, workflow subprocesses, and installation tools use Bash and Linux process
semantics, so native PowerShell execution is not currently supported. Windows
browsers can still open the Web UI through WSL's localhost forwarding.

## 1. Install WSL 2 and Ubuntu

Open **PowerShell as Administrator** and run:

```powershell
wsl --install -d Ubuntu-24.04
```

Restart Windows if prompted, open **Ubuntu** from the Start menu, and create the
Linux username and password requested on first launch. Check the installation
from PowerShell with:

```powershell
wsl --update
wsl --list --verbose
```

Ubuntu 24.04 should report WSL version `2`. That release supplies a supported
Python version out of the box. Microsoft's official references cover
[WSL installation](https://learn.microsoft.com/windows/wsl/install) and the
[recommended development environment](https://learn.microsoft.com/windows/wsl/setup/environment).

## 2. Clone Tesseraft inside WSL

Run the rest of this guide in the **Ubuntu** shell. Keep the checkout in the WSL
filesystem (for example `~/src`), not under `/mnt/c`; Linux filesystem tools and
Node package installation are substantially more reliable there.

```bash
sudo apt-get update
sudo apt-get install -y git
mkdir -p ~/src
cd ~/src
git clone https://github.com/wilbrt/tesseraft.git
cd tesseraft
```

## 3. Install the complete default stack

```bash
./scripts/install-wsl.sh
```

The bootstrap is safe to rerun. It installs:

- Git, OpenSSH, certificates, and the official GitHub CLI package;
- the declared Babashka, Node.js, and npm toolchain;
- Python as a default dependency for workflow helper scripts;
- pinned npm packages, including the Pi CLI; and
- the production Web UI build.

Pi does not need a separate global install. `npm ci` pins it in
`node_modules/.bin`, and `./bin/tesseraft` exposes that local executable to
workflow processes. The final workflow dependency check confirms that `bb`,
Node.js, npm, Python, Git, `gh`, and Pi are all reachable.

## 4. Authenticate GitHub and Pi

Installation can provide the executables, but authentication must be completed
by the user. Configure GitHub CLI and SSH publication from the Ubuntu shell:

```bash
gh auth login --hostname github.com --git-protocol ssh --web
gh auth status
ssh -T git@github.com
```

The SSH test normally exits after GitHub confirms your account; it does not open
a remote shell. If `gh auth login` offers to create or upload an SSH key, accept
that option unless you already manage a WSL-local key.

For OpenCode Go, create or copy an access token from
[opencode.ai/auth](https://opencode.ai/auth), then start the repository-pinned
Pi CLI:

```bash
npm exec -- pi
```

In Pi, run `/login`, select **OpenCode Go**, and paste the access token. Then run
`/model` and select an `opencode-go` model. Pi stores the credential in
`~/.pi/agent/auth.json` with user-only permissions, so future Tesseraft runs use
it automatically. You do not need the OpenCode CLI, a global Pi install, or a
Pi extension. A Pi or GitHub login made on the Windows side is not automatically
available inside WSL.

For a non-interactive shell or CI job, supply the same token through the
environment instead of storing it:

```bash
export OPENCODE_API_KEY='<access-token>'
```

Do not commit that value or place it in a workflow file.

If a Tesseraft project relies on default Pi settings rather than provider/model
values pinned in its workflow, save the selected values globally:

```bash
./bin/tesseraft control-plane settings set --global \
  --pi-default-provider <provider> \
  --pi-default-model <model>
```

## 5. Verify and run Tesseraft

First verify the installed executables:

```bash
./bin/tesseraft doctor --profile workflow
```

Then run the local, side-effect-free smoke workflow:

```bash
./bin/tesseraft lint examples/tutorials/smoke/workflow.edn
./bin/tesseraft run examples/tutorials/smoke/workflow.edn --run-id windows-first-run
./bin/tesseraft control-plane run windows-first-run
```

Start the Web UI:

```bash
./bin/tesseraft web
```

Open [http://localhost:7341](http://localhost:7341) in a Windows browser. WSL 2
forwards localhost ports by default; Microsoft's
[WSL networking guide](https://learn.microsoft.com/windows/wsl/networking)
covers unusual networking configurations.

For an agent workflow, also run the project-aware readiness report:

```bash
./bin/tesseraft control-plane doctor
```

That report checks GitHub authentication, the repository and Git author,
configured credential references, and the selected Pi provider/model. Optional
integrations may remain `not-configured`; address the checks required by the
workflow you plan to run. Full workflows can edit repositories, create
worktrees, push branches, and open pull requests, so read
[Safe workflow runs](../reference/WORKFLOW_RUNS.md) before the first live run.

## Troubleshooting

- **A command works in PowerShell but not Ubuntu:** install or authenticate it
  inside WSL. Windows and WSL have separate executables, home directories, and
  credential stores.
- **The Web UI was not built:** rerun `npm run build:web` from the Tesseraft
  checkout.
- **`pi` is missing:** run `npm ci`, then retry
  `./bin/tesseraft doctor --profile workflow`.
- **`gh auth status` fails:** rerun `gh auth login --git-protocol ssh --web` in
  Ubuntu.
- **Repository operations are slow or file watchers misbehave:** move the
  checkout from `/mnt/c/...` to a directory under `~/...`.
