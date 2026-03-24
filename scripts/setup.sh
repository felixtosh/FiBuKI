#!/usr/bin/env bash
set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m' # No Color

echo ""
echo -e "${BOLD}Setting up FiBuKI...${NC}"
echo ""

# 1. Check Node version
NODE_MAJOR=$(node -v 2>/dev/null | sed 's/v\([0-9]*\).*/\1/' || echo "0")
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo -e "${RED}Error: Node.js >= 20 is required (found: $(node -v 2>/dev/null || echo 'none'))${NC}"
  echo "Install Node.js 20+ from https://nodejs.org"
  exit 1
fi
echo -e "${GREEN}✓${NC} Node.js $(node -v)"

# 2. Install root dependencies
echo ""
echo -e "${BOLD}Installing root dependencies...${NC}"
npm install
echo -e "${GREEN}✓${NC} Root dependencies installed"

# 3. Install functions dependencies
echo ""
echo -e "${BOLD}Installing Cloud Functions dependencies...${NC}"
(cd functions && npm install)
echo -e "${GREEN}✓${NC} Functions dependencies installed"

# 4. Copy .env.example → .env.local if missing
if [ ! -f .env.local ]; then
  cp .env.example .env.local
  echo -e "${GREEN}✓${NC} Created .env.local from .env.example"
  echo -e "  ${YELLOW}→ Edit .env.local to add your Firebase config and API keys${NC}"
else
  echo -e "${GREEN}✓${NC} .env.local already exists"
fi

# 5. Success
echo ""
echo -e "${GREEN}${BOLD}Setup complete!${NC}"
echo ""
echo "Next steps:"
echo "  1. Edit .env.local with your Firebase project credentials"
echo "  2. Install Firebase CLI if needed:  npm install -g firebase-tools"
echo "  3. Start the dev environment:       npm run dev:all"
echo ""
