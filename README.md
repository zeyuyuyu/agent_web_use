# agent_web_use
The repo include the code of agent browser use

Open one terminal at Macbook
## Step 1:
npm install

## Step 2:
npm start

## Step 3:
Open another terminal at Macbook run:
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.chrome‑tars" \
  --disable-blink-features=AutomationControlled \
  --no-first-run --no-default-browser-check

## Step 4:
Open google chrome and login to:
http://localhost:3000/
