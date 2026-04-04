#!/bin/sh
set -e

REPO="https://github.com/Abdr007/bolt-terminal.git"
INSTALL_DIR="$HOME/.flash/bolt-terminal"
MIN_NODE=20

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { printf "${CYAN}[*]${NC} %s\n" "$1"; }
ok()    { printf "${GREEN}[+]${NC} %s\n" "$1"; }
warn()  { printf "${YELLOW}[!]${NC} %s\n" "$1"; }
fail()  { printf "${RED}[x]${NC} %s\n" "$1"; exit 1; }

# --- Prerequisites ---
info "Checking prerequisites..."

command -v git >/dev/null 2>&1 || fail "git is not installed. Please install git first."
command -v node >/dev/null 2>&1 || fail "node is not installed. Please install Node.js >= $MIN_NODE."
command -v npm >/dev/null 2>&1 || fail "npm is not installed. Please install Node.js >= $MIN_NODE."

NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VER" -lt "$MIN_NODE" ] 2>/dev/null; then
  fail "Node.js >= $MIN_NODE required (found v$(node -v | sed 's/v//')). Please upgrade."
fi
ok "Prerequisites satisfied (node v$(node -v | sed 's/v//'), npm v$(npm -v), git)"

# --- Clone or Update ---
mkdir -p "$HOME/.flash"

if [ -d "$INSTALL_DIR/.git" ]; then
  info "Existing installation found. Updating..."
  cd "$INSTALL_DIR"
  git pull --ff-only || fail "git pull failed. Resolve conflicts manually in $INSTALL_DIR"
  ok "Repository updated."
else
  if [ -d "$INSTALL_DIR" ]; then
    warn "Directory $INSTALL_DIR exists but is not a git repo. Removing..."
    rm -rf "$INSTALL_DIR"
  fi
  info "Cloning bolt-terminal..."
  git clone "$REPO" "$INSTALL_DIR" || fail "git clone failed."
  cd "$INSTALL_DIR"
  ok "Repository cloned."
fi

# --- Build ---
info "Installing dependencies..."
npm install --no-fund --no-audit || fail "npm install failed."
info "Building..."
npm run build || fail "Build failed."
ok "Build successful."

# --- Symlink ---
ENTRY="$INSTALL_DIR/dist/index.js"
if [ ! -f "$ENTRY" ]; then
  fail "Build artifact not found at $ENTRY"
fi

create_symlink() {
  TARGET_DIR="$1"
  TARGET="$TARGET_DIR/flash"
  if [ -L "$TARGET" ] || [ -e "$TARGET" ]; then
    rm -f "$TARGET"
  fi
  ln -s "$ENTRY" "$TARGET" && ok "Symlinked flash -> $TARGET"
}

if [ -w /usr/local/bin ]; then
  create_symlink /usr/local/bin
else
  mkdir -p "$HOME/bin"
  create_symlink "$HOME/bin"
  case ":$PATH:" in
    *":$HOME/bin:"*) ;;
    *) warn "Add ~/bin to your PATH: export PATH=\"\$HOME/bin:\$PATH\"" ;;
  esac
fi

# --- Done ---
printf "\n${GREEN}Flash Terminal installed successfully!${NC}\n\n"
printf "  Usage:   ${CYAN}flash${NC}\n"
printf "  Update:  re-run this script\n"
printf "  Config:  ~/.flash/\n\n"
