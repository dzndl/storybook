import path from 'path';
import { Configuration, DefinePlugin, HotModuleReplacementPlugin, ProgressPlugin } from 'webpack';
import HtmlWebpackPlugin from 'html-webpack-plugin';
import CaseSensitivePathsPlugin from 'case-sensitive-paths-webpack-plugin';
import WatchMissingNodeModulesPlugin from 'react-dev-utils/WatchMissingNodeModulesPlugin';
import TerserWebpackPlugin from 'terser-webpack-plugin';
import VirtualModulePlugin from 'webpack-virtual-modules';
import ForkTsCheckerWebpackPlugin from 'fork-ts-checker-webpack-plugin';

import themingPaths from '@storybook/theming/paths';

import {
  toRequireContextString,
  es6Transpiler,
  stringifyProcessEnvs,
  nodeModulesPaths,
  handlebars,
  interpolate,
  Options,
  toImportFn,
  normalizeStories,
  readTemplate,
  loadPreviewOrConfigFile,
} from '@storybook/core-common';
import { createBabelLoader } from './babel-loader-preview';

import { useBaseTsSupport } from './useBaseTsSupport';

const storybookPaths: Record<string, string> = [
  'addons',
  'api',
  'channels',
  'channel-postmessage',
  'components',
  'core-events',
  'router',
  'theming',
  'semver',
  'client-api',
  'client-logger',
].reduce(
  (acc, sbPackage) => ({
    ...acc,
    [`@storybook/${sbPackage}`]: path.dirname(
      require.resolve(`@storybook/${sbPackage}/package.json`)
    ),
  }),
  {}
);

export default async (options: Options & Record<string, any>): Promise<Configuration> => {
  const {
    configDir,
    babelOptions,
    outputDir = path.join('.', 'public'),
    quiet,
    packageJson,
    configType,
    framework,
    frameworkPath,
    presets,
    typescriptOptions,
    modern,
    features,
  } = options;
  const envs = await presets.apply<Record<string, string>>('env');
  const logLevel = await presets.apply('logLevel', undefined);
  const frameworkOptions = await presets.apply(`${framework}Options`, {});

  const headHtmlSnippet = await presets.apply('previewHead');
  const bodyHtmlSnippet = await presets.apply('previewBody');
  const template = await presets.apply<string>('previewMainTemplate');

  const babelLoader = createBabelLoader(babelOptions, framework);
  const isProd = configType === 'PRODUCTION';

  const configs = [
    ...(await presets.apply('config', [], options)),
    loadPreviewOrConfigFile(options),
  ].filter(Boolean);
  const entries = (await presets.apply('entries', [], options)) as string[];
  const workingDir = process.cwd();
  const stories = normalizeStories(await presets.apply('stories', [], options), {
    configDir: options.configDir,
    workingDir,
  });

  const virtualModuleMapping: Record<string, string> = {};
  if (features?.storyStoreV7) {
    const storiesFilename = 'storybook-stories.js';
    const storiesPath = path.resolve(path.join(configDir, storiesFilename));

    virtualModuleMapping[storiesPath] = toImportFn(stories);
    const configEntryPath = path.resolve(path.join(configDir, 'storybook-config-entry.js'));
    virtualModuleMapping[configEntryPath] = handlebars(
      await readTemplate(path.join(__dirname, 'virtualModuleModernEntry.js.handlebars')),
      {
        storiesFilename,
        configs,
      }
    );
    entries.push(configEntryPath);
  } else {
    const frameworkInitEntry = path.resolve(
      path.join(workingDir, 'storybook-init-framework-entry.js')
    );
    const frameworkImportPath = frameworkPath || `@storybook/${framework}`;
    virtualModuleMapping[frameworkInitEntry] = `import '${frameworkImportPath}';`;
    entries.push(frameworkInitEntry);

    const entryTemplate = await readTemplate(
      path.join(__dirname, 'virtualModuleEntry.template.js')
    );

    configs.forEach((configFilename: any) => {
      const clientApi = storybookPaths['@storybook/client-api'];
      const clientLogger = storybookPaths['@storybook/client-logger'];

      virtualModuleMapping[`${configFilename}-generated-config-entry.js`] = interpolate(
        entryTemplate,
        {
          configFilename,
          clientApi,
          clientLogger,
        }
      );
      entries.push(`${configFilename}-generated-config-entry.js`);
    });
    if (stories.length > 0) {
      const storyTemplate = await readTemplate(
        path.join(__dirname, 'virtualModuleStory.template.js')
      );
      const storiesFilename = path.resolve(path.join(workingDir, `generated-stories-entry.js`));
      virtualModuleMapping[storiesFilename] = interpolate(storyTemplate, { frameworkImportPath })
        // Make sure we also replace quotes for this one
        .replace("'{{stories}}'", stories.map(toRequireContextString).join(','));
      entries.push(storiesFilename);
    }
  }

  const shouldCheckTs = useBaseTsSupport(framework) && typescriptOptions.check;
  const tsCheckOptions = typescriptOptions.checkOptions || {};

  return {
    name: 'preview',
    mode: isProd ? 'production' : 'development',
    bail: isProd,
    devtool: 'cheap-module-source-map',
    entry: entries,
    output: {
      path: path.resolve(process.cwd(), outputDir),
      filename: isProd ? '[name].[contenthash:8].iframe.bundle.js' : '[name].iframe.bundle.js',
      publicPath: '',
    },
    stats: {
      preset: 'none',
      logging: 'error',
    },
    watchOptions: {
      ignored: /node_modules/,
    },
    ignoreWarnings: [
      {
        message: /export '\S+' was not found in 'global'/,
      },
    ],
    plugins: [
      Object.keys(virtualModuleMapping).length > 0
        ? new VirtualModulePlugin(virtualModuleMapping)
        : (null as any),
      new HtmlWebpackPlugin({
        filename: `iframe.html`,
        // FIXME: `none` isn't a known option
        chunksSortMode: 'none' as any,
        alwaysWriteToDisk: true,
        inject: false,
        templateParameters: (compilation, files, templateOptions) => ({
          compilation,
          files,
          options: templateOptions,
          version: packageJson.version,
          globals: {
            LOGLEVEL: logLevel,
            FRAMEWORK_OPTIONS: frameworkOptions,
            FEATURES: features,
            STORIES: stories.map((specifier) => ({
              ...specifier,
              importPathMatcher: specifier.importPathMatcher.source,
            })),
          },
          headHtmlSnippet,
          bodyHtmlSnippet,
        }),
        minify: {
          collapseWhitespace: true,
          removeComments: true,
          removeRedundantAttributes: true,
          removeScriptTypeAttributes: false,
          removeStyleLinkTypeAttributes: true,
          useShortDoctype: true,
        },
        template,
      }),
      new DefinePlugin({
        ...stringifyProcessEnvs(envs),
        NODE_ENV: JSON.stringify(process.env.NODE_ENV),
      }),
      isProd ? null : new WatchMissingNodeModulesPlugin(nodeModulesPaths),
      isProd ? null : new HotModuleReplacementPlugin(),
      new CaseSensitivePathsPlugin(),
      quiet ? null : new ProgressPlugin({}),
      shouldCheckTs ? new ForkTsCheckerWebpackPlugin(tsCheckOptions) : null,
    ].filter(Boolean),
    module: {
      rules: [
        babelLoader,
        es6Transpiler() as any,
        {
          test: /\.md$/,
          type: 'asset/source',
        },
      ],
    },
    resolve: {
      extensions: ['.mjs', '.js', '.jsx', '.ts', '.tsx', '.json', '.cjs'],
      modules: ['node_modules'].concat(envs.NODE_PATH || []),
      mainFields: [modern ? 'sbmodern' : null, 'browser', 'module', 'main'].filter(Boolean),
      alias: {
        ...themingPaths,
        ...storybookPaths,
        react: path.dirname(require.resolve('react/package.json')),
        'react-dom': path.dirname(require.resolve('react-dom/package.json')),
      },
      fallback: { path: false },
    },
    optimization: {
      splitChunks: {
        chunks: 'all',
      },
      runtimeChunk: true,
      sideEffects: true,
      usedExports: true,
      moduleIds: 'named',
      minimizer: isProd
        ? [
            new TerserWebpackPlugin({
              parallel: true,
              terserOptions: {
                sourceMap: true,
                mangle: false,
                keep_fnames: true,
              },
              // It looks like the types from `@types/terser-webpack-plugin` are not matching the latest version of
              // Webpack yet
            }) as any,
          ]
        : [],
    },
    performance: {
      hints: isProd ? 'warning' : false,
    },
  };
};
