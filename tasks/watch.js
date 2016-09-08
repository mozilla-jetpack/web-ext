module.exports = {
  options: {
    atBegin: true,
    interrupt: true,
  },
  develop: {
    files: [
      'package.json',
      'src/**/*.js',
      'tasks/**/*.js*',
      'tests/**/*.js*',
      'webpack.config.js',
      '.flowconfig',
    ],
    tasks: [
      'build-tests',
      'mochaTest:unit',
      'flowbin:status',
      'newer:eslint',
    ],
  },
};
