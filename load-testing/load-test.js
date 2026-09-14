import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '1m', target: 5 },
    { duration: '2m', target: 10 },
    { duration: '2m', target: 15 },
    { duration: '1m', target: 0 },
  ],
  thresholds: {
    http_req_failed: ['rate<0.05'],
    checks: ['rate>0.95'],
  },
};

const BASE_URL = 'http://backend-service:8080';

export function setup() {
  const loginResponse = http.post(
    `${BASE_URL}/users/login`,
    JSON.stringify({
      email: 'k6-test@example.com',
      password: 'K6Test123!',
    }),
    {
      headers: {
        'Content-Type': 'application/json',
      },
    }
  );

  check(loginResponse, {
    'login successful': (r) => r.status === 200,
    'authorization token received': (r) =>
      r.headers['Authorization'] !== undefined,
  });

  if (!loginResponse.headers['Authorization']) {
    throw new Error('Login failed: no Authorization header received');
  }

  return {
    authorization: loginResponse.headers['Authorization'],
  };
}

export default function (data) {
  const response = http.get(`${BASE_URL}/users/me`, {
    headers: {
      Authorization: data.authorization,
    },
  });

  check(response, {
    'GET /users/me returns 200': (r) => r.status === 200,
  });

  sleep(0.2);
}
