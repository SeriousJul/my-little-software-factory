#!/usr/bin/env node
/**
 * The control plane entry module. Boots the OpenTUI renderer and mounts the
 * app. Plain TypeScript, no build step: node strips the types and runs this
 * directly.
 */
import { createCliRenderer } from "@opentui/core";
import { createElement, createRoot } from "@opentui/react";

import { App } from "./components/app.ts";

const renderer = await createCliRenderer({ exitOnCtrlC: true });
createRoot(renderer).render(createElement(App));
