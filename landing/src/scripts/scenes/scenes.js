// The page's scenes by name: a figure's data-scene picks one. Each is { duration, fit, look, el,
// fov, yaw?, beats?, shadow, lampAt, build(accent) → { root, pose(t) } }; pose(duration) is its
// settled frame, and beats, if any, are [start, end] spans of t, one per step of its section.
import { placement } from './placement.js';

export const SCENES = { placement };
