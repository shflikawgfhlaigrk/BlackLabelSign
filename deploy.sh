#!/bin/bash
# BL Sign deploy — brand-isolation gate is fail-closed (founder directive 2026-07-12).
set -euo pipefail
cd "$(dirname "$0")"
# Declared exception: TEC is the umbrella brand and the live blacklabeltec.com
# site already surfaces michael@blacklabelbots.com as the canonical contact.
ALLOW=(--allow-term 'michael@blacklabelbots.com')
node ~/BlackLabel-Team/tools/check-brand-isolation.mjs public --self blacklabeltec.com "${ALLOW[@]}"
node ~/BlackLabel-Team/tools/check-brand-isolation.mjs src --self blacklabeltec.com "${ALLOW[@]}"
npx wrangler deploy
