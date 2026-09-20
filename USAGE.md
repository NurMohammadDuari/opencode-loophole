### How to view the dashboard page

1. **Start the dashboard server**  
   The server is the Node script `dashboard/dashboard-server.js`.  
   You can run it **manual​ly** (good for a quick test) or **as a system service** (so it starts automatically on boot).

   **A. Quick‑test (manual start)**
   ```bash
   cd /home/mint/Desktop/opencode-zen-loophole
   # make sure Node is on your PATH
   node dashboard/dashboard-server.js
   ```
   You should see a line like:
   ```
   Server listening on http://127.0.0.1:1395
   ```
   Leave that terminal window running.

   **B. System‑wide service (runs on boot, requires sudo)**
   1. Create the service unit (run once):
      ```bash
      sudo tee /etc/systemd/system/opencode-dashboard.service > /dev/null <<'EOF'
      [Unit]
      Description=OpenCode Zen Loophole Dashboard
      After=network.target

      [Service]
      Type=simple
      WorkingDirectory=/home/mint/Desktop/opencode-zen-loophole
      ExecStart=/usr/bin/node dashboard/dashboard-server.js
      Restart=on-failure
      # optional: limit resources, set user/group if desired
      # User=mint
      # Group=mint

      [Install]
      WantedBy=multi-user.target
      EOF
      ```

   2. Reload systemd, enable and start the service:
      ```bash
      sudo systemctl daemon-reload
      sudo systemctl enable --now opencode-dashboard.service
      ```

   3. Verify it’s running:
      ```bash
      sudo systemctl status opencode-dashboard.service
      ```
      You should see **active (running)** and the same “Server listening...” line in the journal:
      ```bash
      journalctl -u opencode-dashboard.service -f
      ```

2. **Open the UI in a browser**

   Once the server is running, open any web browser (Chrome, Firefox, etc.) and go to:

   ```
   http://127.0.0.1:1395/
   ```

   - The page will load the **90s‑style UI** automatically.
   - The stream starts on page load (the button is now just decorative because the script auto‑connects to `/api/stream`).

3. **Optional: Stop the service**

   - If you used the manual start, just press `Ctrl‑C` in the terminal.
   - If you used the system service:
     ```bash
     sudo systemctl stop opencode-dashboard.service
     ```

4. **Troubleshooting tips**

   | Symptom                              | Check / Fix |
   |--------------------------------------|-------------|
   | `node: command not found`            | Install Node (`sudo apt install nodejs npm` or use a version manager). |
   | Port 1395 already in use            | Ensure no other instance is running: `sudo lsof -i:1395` and kill it, or change the port in `dashboard/dashboard-server.js`. |
   | Service fails to start               | View logs: `journalctl -u opencode-dashboard.service -b`. |
   | Page shows “Waiting for stream…”    | Verify the server logs show `EventSource` connections; the `app.js` script auto‑connects on load. |

That’s all you need. After the service is up, just navigate to `http://127.0.0.1:1395/` and you’ll see the retro‑styled control center with live telemetry. Let me know if you encounter any issues or want to tweak the service (e.g., run it under the `mint` user instead of root).
