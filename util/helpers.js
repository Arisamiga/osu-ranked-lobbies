import fs from 'fs';
import Mustache from 'mustache';

import Sentry from '@sentry/node';
import Config from './config.js';


const base = fs.readFileSync('public/index.html', 'utf-8');


export function capture_sentry_exception(err) {
  if (Config.ENABLE_SENTRY) {
    Sentry.captureException(err);
    Sentry.configureScope((scope) => scope.clear());
  } else {
    console.error(err);
  }
}

export function random_from(arr) {
  return arr[Math.floor((Math.random() * arr.length))];
}

export const render_error = async (req, error, code, data = {}) => {
  data.error = error;
  data.user_id = req.user_id;
  return await Mustache.render(base, data);
};
