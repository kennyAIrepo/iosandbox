# Accessing your B3IQ machine over SSH

Get a terminal on your machine from your own computer. One-time setup, ~5 minutes.

---

## 1. Install cloudflared (the secure tunnel B3IQ uses)

- **macOS:** `brew install cloudflared`
- **Windows:** `winget install Cloudflare.cloudflared`
  *(if that hangs, just download `cloudflared-windows-amd64.exe` from the cloudflared GitHub releases page and rename it `cloudflared.exe`)*
- **Linux:** `sudo apt install cloudflared` *(or download the binary from releases)*

## 2. Create an SSH key (skip if you already have one)

```
ssh-keygen -t ed25519 -C "your-name"
```
Press Enter through the prompts. This makes two files: a **private** key (stays on your computer — never share it) and a **public** key ending in `.pub`.

Print the public key so you can copy it:
- **macOS/Linux:** `cat ~/.ssh/id_ed25519.pub`
- **Windows (PowerShell):** `type $env:USERPROFILE\.ssh\id_ed25519.pub`

## 3. Add the public key in the dashboard

Go to **My machines → (your machine) → Access & controls**. In the **SSH ACCESS** box:
1. Paste the whole `ssh-ed25519 …` line into the text box.
2. Add a label (e.g. `my-laptop`), choose **This machine**, click **Add key**.
3. Wait until its **STATE** shows **✅ Applied**.

## 4. Add the connection to your SSH config

On that same page, the **Native SSH** section shows a ready-made config block — copy it into your SSH config file (`~/.ssh/config`; create the file if it doesn't exist). It looks like:

```
Host ssh-node-b3iq-<your-id>.b3iq.org
  ProxyCommand cloudflared access ssh --hostname %h
  User b3iq
```

*(Windows only: if `cloudflared` isn't on your PATH, use its full path, e.g.*
`ProxyCommand C:/Users/you/cloudflared.exe access ssh --hostname %h`*)*

## 5. Connect

```
ssh ssh-node-b3iq-<your-id>.b3iq.org
```

You're now on the machine (user `b3iq`, with `sudo`). `scp`, `sftp`, and `rsync` work over the same connection for moving files.

---

**Note:** SSH is available while the machine is in **Bare metal** mode. In **Earn mode** SSH is turned off — switch back to Bare metal to reconnect.
