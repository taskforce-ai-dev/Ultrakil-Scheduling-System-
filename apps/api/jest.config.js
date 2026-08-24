/** @type {import('jest').Config} */
module.exports = {
  projects: [
    {
      displayName: 'unit',
      preset: 'ts-jest',
      testEnvironment: 'node',
      rootDir: '.',
      testMatch: [
        '<rootDir>/src/**/*.spec.ts',
        '<rootDir>/test/unit/**/*.spec.ts',
      ],
      moduleFileExtensions: ['ts', 'js', 'json'],
    },
    {
      displayName: 'integration',
      preset: 'ts-jest',
      testEnvironment: 'node',
      rootDir: '.',
      testMatch: ['<rootDir>/test/integration/**/*.spec.ts'],
      moduleFileExtensions: ['ts', 'js', 'json'],
      setupFilesAfterEnv: ['<rootDir>/test/integration/jest.setup.ts'],
    },
  ],
};
