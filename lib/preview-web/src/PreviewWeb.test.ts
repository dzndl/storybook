import global from 'global';
import Events from '@storybook/core-events';
import * as ReactDOM from 'react-dom';
import { logger } from '@storybook/client-logger';
import merge from 'lodash/merge';
import addons from '@storybook/addons';

import { PreviewWeb } from './PreviewWeb';
import {
  componentOneExports,
  componentTwoExports,
  importFn,
  projectAnnotations,
  getProjectAnnotations,
  storyIndex,
  emitter,
  mockChannel,
  waitForEvents,
  waitForRender,
  waitForQuiescence,
} from './PreviewWeb.mockdata';

jest.mock('./WebView');
const { history, document } = global;

const mockStoryIndex = jest.fn(() => storyIndex);

jest.mock('global', () => ({
  ...(jest.requireActual('global') as any),
  history: { replaceState: jest.fn() },
  document: {
    location: {
      pathname: 'pathname',
      search: '?id=*',
    },
  },
  FEATURES: {
    storyStoreV7: true,
    breakingChangesV7: true,
    // xxx
  },
  fetch: async () => ({ json: mockStoryIndex }),
}));

jest.mock('@storybook/client-logger');
jest.mock('react-dom');

const createGate = (): [Promise<any | undefined>, (_?: any) => void] => {
  let openGate = (_?: any) => {};
  const gate = new Promise<any | undefined>((resolve) => {
    openGate = resolve;
  });
  return [gate, openGate];
};

beforeEach(() => {
  document.location.search = '';
  mockChannel.emit.mockClear();
  emitter.removeAllListeners();
  componentOneExports.default.loaders[0].mockReset().mockImplementation(async () => ({ l: 7 }));
  componentOneExports.default.parameters.docs.container.mockClear();
  componentOneExports.a.play.mockReset();
  projectAnnotations.renderToDOM.mockReset();
  projectAnnotations.render.mockClear();
  projectAnnotations.decorators[0].mockClear();
  // @ts-ignore
  ReactDOM.render.mockReset().mockImplementation((_: any, _2: any, cb: () => any) => cb());
  // @ts-ignore
  logger.warn.mockClear();
  mockStoryIndex.mockReset().mockReturnValue(storyIndex);

  addons.setChannel(mockChannel as any);
});

describe('PreviewWeb', () => {
  describe('constructor', () => {
    it('shows an error if getProjectAnnotations throws', async () => {
      const err = new Error('meta error');
      const preview = new PreviewWeb();
      preview.initialize({
        importFn,
        getProjectAnnotations: () => {
          throw err;
        },
      });

      expect(preview.view.showErrorDisplay).toHaveBeenCalled();
      expect(mockChannel.emit).toHaveBeenCalledWith(Events.CONFIG_ERROR, err);
    });
  });

  describe('initialize', () => {
    it('sets globals from the URL', async () => {
      document.location.search = '?id=*&globals=a:c';

      const preview = new PreviewWeb();
      await preview.initialize({ importFn, getProjectAnnotations });

      expect(preview.storyStore.globals.get()).toEqual({ a: 'c' });
    });

    it('emits the SET_GLOBALS event', async () => {
      await new PreviewWeb().initialize({ importFn, getProjectAnnotations });

      expect(mockChannel.emit).toHaveBeenCalledWith(Events.SET_GLOBALS, {
        globals: { a: 'b' },
        globalTypes: {},
      });
    });

    it('SET_GLOBALS sets globals and types even when undefined', async () => {
      await new PreviewWeb().initialize({ importFn, getProjectAnnotations: () => ({}) });

      expect(mockChannel.emit).toHaveBeenCalledWith(Events.SET_GLOBALS, {
        globals: {},
        globalTypes: {},
      });
    });

    it('emits the SET_GLOBALS event from the URL', async () => {
      document.location.search = '?id=*&globals=a:c';

      await new PreviewWeb().initialize({ importFn, getProjectAnnotations });

      expect(mockChannel.emit).toHaveBeenCalledWith(Events.SET_GLOBALS, {
        globals: { a: 'c' },
        globalTypes: {},
      });
    });

    it('sets args from the URL', async () => {
      document.location.search = '?id=component-one--a&args=foo:url';

      const preview = new PreviewWeb();
      await preview.initialize({ importFn, getProjectAnnotations });

      expect(preview.storyStore.args.get('component-one--a')).toEqual({
        foo: 'url',
      });
    });
  });

  describe('initial selection', () => {
    it('selects the story specified in the URL', async () => {
      document.location.search = '?id=component-one--a';

      const preview = new PreviewWeb();
      await preview.initialize({ importFn, getProjectAnnotations });

      expect(preview.urlStore.selection).toEqual({
        storyId: 'component-one--a',
        viewMode: 'story',
      });
      expect(history.replaceState).toHaveBeenCalledWith(
        {},
        '',
        'pathname?id=component-one--a&viewMode=story'
      );
    });

    it('emits the STORY_SPECIFIED event', async () => {
      document.location.search = '?id=component-one--a';

      await new PreviewWeb().initialize({ importFn, getProjectAnnotations });

      expect(mockChannel.emit).toHaveBeenCalledWith(Events.STORY_SPECIFIED, {
        storyId: 'component-one--a',
        viewMode: 'story',
      });
    });

    it('emits the CURRENT_STORY_WAS_SET event', async () => {
      document.location.search = '?id=component-one--a';

      await new PreviewWeb().initialize({ importFn, getProjectAnnotations });

      expect(mockChannel.emit).toHaveBeenCalledWith(Events.CURRENT_STORY_WAS_SET, {
        storyId: 'component-one--a',
        viewMode: 'story',
      });
    });

    describe('if the story specified does not exist', () => {
      it('renders missing', async () => {
        document.location.search = '?id=random';

        const preview = new PreviewWeb();
        await preview.initialize({ importFn, getProjectAnnotations });

        expect(preview.view.showNoPreview).toHaveBeenCalled();
        expect(mockChannel.emit).toHaveBeenCalledWith(Events.STORY_MISSING, 'random');
      });

      it('tries again with a specifier if CSF file changes', async () => {
        document.location.search = '?id=component-one--d';

        const preview = new PreviewWeb();
        await preview.initialize({ importFn, getProjectAnnotations });

        expect(preview.view.showNoPreview).toHaveBeenCalled();
        expect(mockChannel.emit).toHaveBeenCalledWith(Events.STORY_MISSING, 'component-one--d');

        mockChannel.emit.mockClear();
        const newComponentOneExports = merge({}, componentOneExports, {
          d: { args: { foo: 'd' }, play: jest.fn() },
        });
        const newImportFn = jest.fn(async (path) => {
          return path === './src/ComponentOne.stories.js'
            ? newComponentOneExports
            : componentTwoExports;
        });
        preview.onStoriesChanged({
          importFn: newImportFn,
          storyIndex: {
            v: 3,
            stories: {
              ...storyIndex.stories,
              'component-one--d': {
                title: 'Component One',
                name: 'D',
                importPath: './src/ComponentOne.stories.js',
              },
            },
          },
        });
        await waitForRender();

        expect(mockChannel.emit).toHaveBeenCalledWith(Events.STORY_SPECIFIED, {
          storyId: 'component-one--d',
          viewMode: 'story',
        });
      });

      it('DOES NOT try again if CSF file changes if selection changed', async () => {
        document.location.search = '?id=component-one--d';

        const preview = new PreviewWeb();
        await preview.initialize({ importFn, getProjectAnnotations });

        expect(preview.view.showNoPreview).toHaveBeenCalled();
        expect(mockChannel.emit).toHaveBeenCalledWith(Events.STORY_MISSING, 'component-one--d');

        emitter.emit(Events.SET_CURRENT_STORY, {
          storyId: 'component-one--b',
          viewMode: 'story',
        });

        const newComponentOneExports = merge({}, componentOneExports, {
          d: { args: { foo: 'd' }, play: jest.fn() },
        });
        const newImportFn = jest.fn(async (path) => {
          return path === './src/ComponentOne.stories.js'
            ? newComponentOneExports
            : componentTwoExports;
        });

        preview.onStoriesChanged({
          importFn: newImportFn,
          storyIndex: {
            v: 3,
            stories: {
              ...storyIndex.stories,
              'component-one--d': {
                title: 'Component One',
                name: 'D',
                importPath: './src/ComponentOne.stories.js',
              },
            },
          },
        });
        expect(mockChannel.emit).not.toHaveBeenCalledWith(Events.STORY_SPECIFIED, {
          storyId: 'component-one--d',
          viewMode: 'story',
        });
      });
    });

    it('renders missing if no selection', async () => {
      const preview = new PreviewWeb();
      await preview.initialize({ importFn, getProjectAnnotations });

      expect(preview.view.showNoPreview).toHaveBeenCalled();
      expect(mockChannel.emit).toHaveBeenCalledWith(Events.STORY_MISSING, undefined);
    });

    describe('in story viewMode', () => {
      it('calls view.prepareForStory', async () => {
        document.location.search = '?id=component-one--a';

        const preview = new PreviewWeb();
        await preview.initialize({ importFn, getProjectAnnotations });

        expect(preview.view.prepareForStory).toHaveBeenCalledWith(
          expect.objectContaining({
            id: 'component-one--a',
          })
        );
      });

      it('emits STORY_PREPARED', async () => {
        document.location.search = '?id=component-one--a';
        await new PreviewWeb().initialize({ importFn, getProjectAnnotations });

        expect(mockChannel.emit).toHaveBeenCalledWith(Events.STORY_PREPARED, {
          id: 'component-one--a',
          parameters: { __isArgsStory: false, docs: { container: expect.any(Function) } },
          initialArgs: { foo: 'a' },
          argTypes: { foo: { name: 'foo', type: { name: 'string' } } },
          args: { foo: 'a' },
        });
      });

      it('applies loaders with story context', async () => {
        document.location.search = '?id=component-one--a';
        await new PreviewWeb().initialize({ importFn, getProjectAnnotations });

        await waitForRender();

        expect(componentOneExports.default.loaders[0]).toHaveBeenCalledWith(
          expect.objectContaining({
            id: 'component-one--a',
            parameters: { __isArgsStory: false, docs: { container: expect.any(Function) } },
            initialArgs: { foo: 'a' },
            argTypes: { foo: { name: 'foo', type: { name: 'string' } } },
            args: { foo: 'a' },
          })
        );
      });

      it('passes loaded context to renderToDOM', async () => {
        document.location.search = '?id=component-one--a';
        await new PreviewWeb().initialize({ importFn, getProjectAnnotations });

        await waitForRender();

        expect(projectAnnotations.renderToDOM).toHaveBeenCalledWith(
          expect.objectContaining({
            forceRemount: true,
            storyContext: expect.objectContaining({
              id: 'component-one--a',
              parameters: { __isArgsStory: false, docs: { container: expect.any(Function) } },
              globals: { a: 'b' },
              initialArgs: { foo: 'a' },
              argTypes: { foo: { name: 'foo', type: { name: 'string' } } },
              args: { foo: 'a' },
              loaded: { l: 7 },
            }),
          }),
          undefined // this is coming from view.prepareForStory, not super important
        );
      });

      it('renders exception if a loader throws', async () => {
        const error = new Error('error');
        componentOneExports.default.loaders[0].mockImplementationOnce(() => {
          throw error;
        });

        document.location.search = '?id=component-one--a';
        const preview = new PreviewWeb();
        await preview.initialize({ importFn, getProjectAnnotations });

        await waitForRender();

        expect(mockChannel.emit).toHaveBeenCalledWith(Events.STORY_THREW_EXCEPTION, error);
        expect(preview.view.showErrorDisplay).toHaveBeenCalledWith(error);
      });

      it('renders exception if renderToDOM throws', async () => {
        const error = new Error('error');
        projectAnnotations.renderToDOM.mockImplementationOnce(() => {
          throw error;
        });

        document.location.search = '?id=component-one--a';
        const preview = new PreviewWeb();
        await preview.initialize({ importFn, getProjectAnnotations });

        await waitForRender();

        expect(mockChannel.emit).toHaveBeenCalledWith(Events.STORY_THREW_EXCEPTION, error);
        expect(preview.view.showErrorDisplay).toHaveBeenCalledWith(error);
      });

      it('renders exception if the play function throws', async () => {
        const error = new Error('error');
        componentOneExports.a.play.mockImplementationOnce(() => {
          throw error;
        });

        document.location.search = '?id=component-one--a';
        const preview = new PreviewWeb();
        await preview.initialize({ importFn, getProjectAnnotations });

        await waitForRender();

        expect(mockChannel.emit).toHaveBeenCalledWith(Events.STORY_THREW_EXCEPTION, error);
        expect(preview.view.showErrorDisplay).toHaveBeenCalledWith(error);
      });

      it('renders error if the story calls showError', async () => {
        const error = { title: 'title', description: 'description' };
        projectAnnotations.renderToDOM.mockImplementationOnce((context) =>
          context.showError(error)
        );

        document.location.search = '?id=component-one--a';
        const preview = new PreviewWeb();
        await preview.initialize({ importFn, getProjectAnnotations });

        await waitForRender();

        expect(mockChannel.emit).toHaveBeenCalledWith(Events.STORY_ERRORED, error);
        expect(preview.view.showErrorDisplay).toHaveBeenCalledWith({
          message: error.title,
          stack: error.description,
        });
      });

      it('renders exception if the story calls showException', async () => {
        const error = new Error('error');
        projectAnnotations.renderToDOM.mockImplementationOnce((context) =>
          context.showException(error)
        );

        document.location.search = '?id=component-one--a';
        const preview = new PreviewWeb();
        await preview.initialize({ importFn, getProjectAnnotations });

        await waitForRender();

        expect(mockChannel.emit).toHaveBeenCalledWith(Events.STORY_THREW_EXCEPTION, error);
        expect(preview.view.showErrorDisplay).toHaveBeenCalledWith(error);
      });

      it('executes runPlayFunction', async () => {
        document.location.search = '?id=component-one--a';
        await new PreviewWeb().initialize({ importFn, getProjectAnnotations });

        await waitForRender();

        expect(componentOneExports.a.play).toHaveBeenCalled();
      });

      it('emits STORY_RENDERED', async () => {
        document.location.search = '?id=component-one--a';
        await new PreviewWeb().initialize({ importFn, getProjectAnnotations });

        await waitForRender();

        expect(mockChannel.emit).toHaveBeenCalledWith(Events.STORY_RENDERED, 'component-one--a');
      });
    });

    describe('in docs viewMode', () => {
      it('calls view.prepareForDocs', async () => {
        document.location.search = '?id=component-one--a&viewMode=docs';

        const preview = new PreviewWeb();
        await preview.initialize({ importFn, getProjectAnnotations });

        expect(preview.view.prepareForDocs).toHaveBeenCalled();
      });

      it('emits STORY_PREPARED', async () => {
        document.location.search = '?id=component-one--a&viewMode=docs';
        await new PreviewWeb().initialize({ importFn, getProjectAnnotations });

        expect(mockChannel.emit).toHaveBeenCalledWith(Events.STORY_PREPARED, {
          id: 'component-one--a',
          parameters: { __isArgsStory: false, docs: { container: expect.any(Function) } },
          initialArgs: { foo: 'a' },
          argTypes: { foo: { name: 'foo', type: { name: 'string' } } },
          args: { foo: 'a' },
        });
      });

      it('render the docs container with the correct context', async () => {
        document.location.search = '?id=component-one--a&viewMode=docs';

        await new PreviewWeb().initialize({ importFn, getProjectAnnotations });

        await waitForRender();

        expect(ReactDOM.render).toHaveBeenCalledWith(
          expect.objectContaining({
            type: componentOneExports.default.parameters.docs.container,
            props: expect.objectContaining({
              context: expect.objectContaining({
                id: 'component-one--a',
                title: 'Component One',
                name: 'A',
              }),
            }),
          }),
          undefined,
          expect.any(Function)
        );
      });

      it('emits DOCS_RENDERED', async () => {
        document.location.search = '?id=component-one--a&viewMode=docs';

        await new PreviewWeb().initialize({ importFn, getProjectAnnotations });

        await waitForRender();

        expect(mockChannel.emit).toHaveBeenCalledWith(Events.DOCS_RENDERED, 'component-one--a');
      });
    });
  });

  describe('onUpdateGlobals', () => {
    it('emits GLOBALS_UPDATED', async () => {
      document.location.search = '?id=component-one--a';
      await new PreviewWeb().initialize({ importFn, getProjectAnnotations });

      emitter.emit(Events.UPDATE_GLOBALS, { globals: { foo: 'bar' } });

      expect(mockChannel.emit).toHaveBeenCalledWith(Events.GLOBALS_UPDATED, {
        globals: { a: 'b', foo: 'bar' },
        initialGlobals: { a: 'b' },
      });
    });

    it('sets new globals on the store', async () => {
      document.location.search = '?id=component-one--a';
      const preview = new PreviewWeb();
      await preview.initialize({ importFn, getProjectAnnotations });

      emitter.emit(Events.UPDATE_GLOBALS, { globals: { foo: 'bar' } });

      expect(preview.storyStore.globals.get()).toEqual({ a: 'b', foo: 'bar' });
    });

    it('passes new globals in context to renderToDOM', async () => {
      document.location.search = '?id=component-one--a';
      const preview = new PreviewWeb();
      await preview.initialize({ importFn, getProjectAnnotations });
      await waitForRender();

      mockChannel.emit.mockClear();
      projectAnnotations.renderToDOM.mockClear();
      emitter.emit(Events.UPDATE_GLOBALS, { globals: { foo: 'bar' } });
      await waitForRender();

      expect(projectAnnotations.renderToDOM).toHaveBeenCalledWith(
        expect.objectContaining({
          forceRemount: false,
          storyContext: expect.objectContaining({
            globals: { a: 'b', foo: 'bar' },
          }),
        }),
        undefined // this is coming from view.prepareForStory, not super important
      );
    });

    it('emits STORY_RENDERED', async () => {
      document.location.search = '?id=component-one--a';
      await new PreviewWeb().initialize({ importFn, getProjectAnnotations });
      await waitForRender();

      mockChannel.emit.mockClear();
      emitter.emit(Events.UPDATE_GLOBALS, { globals: { foo: 'bar' } });
      await waitForRender();

      expect(mockChannel.emit).toHaveBeenCalledWith(Events.STORY_RENDERED, 'component-one--a');
    });

    describe('in docs mode', () => {
      it('re-renders the docs container', async () => {
        document.location.search = '?id=component-one--a&viewMode=docs';

        await new PreviewWeb().initialize({ importFn, getProjectAnnotations });
        await waitForRender();

        mockChannel.emit.mockClear();
        emitter.emit(Events.UPDATE_GLOBALS, { globals: { foo: 'bar' } });
        await waitForRender();

        expect(ReactDOM.render).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe('onUpdateArgs', () => {
    it('emits STORY_ARGS_UPDATED', async () => {
      document.location.search = '?id=component-one--a';
      await new PreviewWeb().initialize({ importFn, getProjectAnnotations });

      emitter.emit(Events.UPDATE_STORY_ARGS, {
        storyId: 'component-one--a',
        updatedArgs: { new: 'arg' },
      });

      expect(mockChannel.emit).toHaveBeenCalledWith(Events.STORY_ARGS_UPDATED, {
        storyId: 'component-one--a',
        args: { foo: 'a', new: 'arg' },
      });
    });

    it('sets new args on the store', async () => {
      document.location.search = '?id=component-one--a';
      const preview = new PreviewWeb();
      await preview.initialize({ importFn, getProjectAnnotations });

      emitter.emit(Events.UPDATE_STORY_ARGS, {
        storyId: 'component-one--a',
        updatedArgs: { new: 'arg' },
      });

      expect(preview.storyStore.args.get('component-one--a')).toEqual({
        foo: 'a',
        new: 'arg',
      });
    });

    it('passes new args in context to renderToDOM', async () => {
      document.location.search = '?id=component-one--a';
      const preview = new PreviewWeb();
      await preview.initialize({ importFn, getProjectAnnotations });
      await waitForRender();

      mockChannel.emit.mockClear();
      projectAnnotations.renderToDOM.mockClear();
      emitter.emit(Events.UPDATE_STORY_ARGS, {
        storyId: 'component-one--a',
        updatedArgs: { new: 'arg' },
      });
      await waitForRender();

      expect(projectAnnotations.renderToDOM).toHaveBeenCalledWith(
        expect.objectContaining({
          forceRemount: false,
          storyContext: expect.objectContaining({
            initialArgs: { foo: 'a' },
            args: { foo: 'a', new: 'arg' },
          }),
        }),
        undefined // this is coming from view.prepareForStory, not super important
      );
    });

    it('emits STORY_RENDERED', async () => {
      document.location.search = '?id=component-one--a';
      await new PreviewWeb().initialize({ importFn, getProjectAnnotations });
      await waitForRender();

      mockChannel.emit.mockClear();
      emitter.emit(Events.UPDATE_STORY_ARGS, {
        storyId: 'component-one--a',
        updatedArgs: { new: 'arg' },
      });
      await waitForRender();

      expect(mockChannel.emit).toHaveBeenCalledWith(Events.STORY_RENDERED, 'component-one--a');
    });

    describe('while story is still rendering', () => {
      it('silently changes args if still running loaders', async () => {
        const [gate, openGate] = createGate();

        document.location.search = '?id=component-one--a';
        componentOneExports.default.loaders[0].mockImplementationOnce(async () => gate);
        await new PreviewWeb().initialize({ importFn, getProjectAnnotations });

        emitter.emit(Events.UPDATE_STORY_ARGS, {
          storyId: 'component-one--a',
          updatedArgs: { new: 'arg' },
        });

        // Now let the loader resolve
        openGate({ l: 8 });
        await waitForRender();

        // Story gets rendered with updated args
        expect(projectAnnotations.renderToDOM).toHaveBeenCalledTimes(1);
        expect(projectAnnotations.renderToDOM).toHaveBeenCalledWith(
          expect.objectContaining({
            forceRemount: true,
            storyContext: expect.objectContaining({
              loaded: { l: 8 },
              args: { foo: 'a', new: 'arg' },
            }),
          }),
          undefined // this is coming from view.prepareForStory, not super important
        );
      });

      it('renders a second time if renderToDOM is running', async () => {
        const [gate, openGate] = createGate();

        document.location.search = '?id=component-one--a';
        projectAnnotations.renderToDOM.mockImplementationOnce(async () => gate);
        await new PreviewWeb().initialize({ importFn, getProjectAnnotations });

        emitter.emit(Events.UPDATE_STORY_ARGS, {
          storyId: 'component-one--a',
          updatedArgs: { new: 'arg' },
        });

        // Now let the renderToDOM call resolve
        openGate();
        await waitForRender();

        expect(projectAnnotations.renderToDOM).toHaveBeenCalledTimes(2);
        expect(projectAnnotations.renderToDOM).toHaveBeenCalledWith(
          expect.objectContaining({
            forceRemount: true,
            storyContext: expect.objectContaining({
              loaded: { l: 7 },
              args: { foo: 'a' },
            }),
          }),
          undefined // this is coming from view.prepareForStory, not super important
        );
        expect(projectAnnotations.renderToDOM).toHaveBeenCalledWith(
          expect.objectContaining({
            forceRemount: false,
            storyContext: expect.objectContaining({
              loaded: { l: 7 },
              args: { foo: 'a', new: 'arg' },
            }),
          }),
          undefined // this is coming from view.prepareForStory, not super important
        );
      });

      it('works if it is called directly from inside non async renderToDOM', async () => {
        document.location.search = '?id=component-one--a';
        projectAnnotations.renderToDOM.mockImplementationOnce(() => {
          emitter.emit(Events.UPDATE_STORY_ARGS, {
            storyId: 'component-one--a',
            updatedArgs: { new: 'arg' },
          });
        });
        await new PreviewWeb().initialize({ importFn, getProjectAnnotations });

        await waitForRender();

        expect(projectAnnotations.renderToDOM).toHaveBeenCalledTimes(2);
        expect(projectAnnotations.renderToDOM).toHaveBeenCalledWith(
          expect.objectContaining({
            forceRemount: true,
            storyContext: expect.objectContaining({
              loaded: { l: 7 },
              args: { foo: 'a' },
            }),
          }),
          undefined // this is coming from view.prepareForStory, not super important
        );
        expect(projectAnnotations.renderToDOM).toHaveBeenCalledWith(
          expect.objectContaining({
            forceRemount: false,
            storyContext: expect.objectContaining({
              loaded: { l: 7 },
              args: { foo: 'a', new: 'arg' },
            }),
          }),
          undefined // this is coming from view.prepareForStory, not super important
        );
      });

      it('warns and calls renderToDOM again if play function is running', async () => {
        const [gate, openGate] = createGate();
        componentOneExports.a.play.mockImplementationOnce(async () => gate);

        const renderToDOMCalled = new Promise((resolve) => {
          projectAnnotations.renderToDOM.mockImplementationOnce(() => {
            resolve(null);
          });
        });

        document.location.search = '?id=component-one--a';
        await new PreviewWeb().initialize({ importFn, getProjectAnnotations });

        await renderToDOMCalled;
        // Story gets rendered with original args
        expect(projectAnnotations.renderToDOM).toHaveBeenCalledWith(
          expect.objectContaining({
            forceRemount: true,
            storyContext: expect.objectContaining({
              loaded: { l: 7 },
              args: { foo: 'a' },
            }),
          }),
          undefined // this is coming from view.prepareForStory, not super important
        );

        emitter.emit(Events.UPDATE_STORY_ARGS, {
          storyId: 'component-one--a',
          updatedArgs: { new: 'arg' },
        });

        // The second call should emit STORY_RENDERED
        await waitForRender();

        // Story gets rendered with updated args
        expect(projectAnnotations.renderToDOM).toHaveBeenCalledWith(
          expect.objectContaining({
            forceRemount: false,
            storyContext: expect.objectContaining({
              loaded: { l: 7 },
              args: { foo: 'a', new: 'arg' },
            }),
          }),
          undefined // this is coming from view.prepareForStory, not super important
        );

        // Now let the runPlayFunction call resolve
        openGate();
      });
    });

    describe('in docs mode', () => {
      it('re-renders the docs container', async () => {
        document.location.search = '?id=component-one--a&viewMode=docs';

        await new PreviewWeb().initialize({ importFn, getProjectAnnotations });
        await waitForRender();

        mockChannel.emit.mockClear();
        emitter.emit(Events.UPDATE_STORY_ARGS, {
          storyId: 'component-one--a',
          updatedArgs: { new: 'arg' },
        });
        await waitForRender();

        expect(ReactDOM.render).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe('onResetArgs', () => {
    it('emits STORY_ARGS_UPDATED', async () => {
      document.location.search = '?id=component-one--a';
      await new PreviewWeb().initialize({ importFn, getProjectAnnotations });
      mockChannel.emit.mockClear();
      emitter.emit(Events.UPDATE_STORY_ARGS, {
        storyId: 'component-one--a',
        updatedArgs: { foo: 'new' },
      });

      expect(mockChannel.emit).toHaveBeenCalledWith(Events.STORY_ARGS_UPDATED, {
        storyId: 'component-one--a',
        args: { foo: 'new' },
      });

      mockChannel.emit.mockClear();
      emitter.emit(Events.RESET_STORY_ARGS, {
        storyId: 'component-one--a',
        argNames: ['foo'],
      });

      await waitForEvents([Events.STORY_ARGS_UPDATED]);

      expect(mockChannel.emit).toHaveBeenCalledWith(Events.STORY_ARGS_UPDATED, {
        storyId: 'component-one--a',
        args: { foo: 'a' },
      });
    });

    it('resets a single arg', async () => {
      document.location.search = '?id=component-one--a';
      await new PreviewWeb().initialize({ importFn, getProjectAnnotations });
      mockChannel.emit.mockClear();
      emitter.emit(Events.UPDATE_STORY_ARGS, {
        storyId: 'component-one--a',
        updatedArgs: { foo: 'new', new: 'value' },
      });

      mockChannel.emit.mockClear();
      emitter.emit(Events.RESET_STORY_ARGS, {
        storyId: 'component-one--a',
        argNames: ['foo'],
      });

      await waitForRender();

      expect(projectAnnotations.renderToDOM).toHaveBeenCalledWith(
        expect.objectContaining({
          forceRemount: false,
          storyContext: expect.objectContaining({
            initialArgs: { foo: 'a' },
            args: { foo: 'a', new: 'value' },
          }),
        }),
        undefined // this is coming from view.prepareForStory, not super important
      );

      expect(mockChannel.emit).toHaveBeenCalledWith(Events.STORY_ARGS_UPDATED, {
        storyId: 'component-one--a',
        args: { foo: 'a', new: 'value' },
      });
    });

    it('resets all args', async () => {
      document.location.search = '?id=component-one--a';
      await new PreviewWeb().initialize({ importFn, getProjectAnnotations });
      emitter.emit(Events.UPDATE_STORY_ARGS, {
        storyId: 'component-one--a',
        updatedArgs: { foo: 'new', new: 'value' },
      });

      mockChannel.emit.mockClear();
      emitter.emit(Events.RESET_STORY_ARGS, {
        storyId: 'component-one--a',
      });

      await waitForRender();

      expect(projectAnnotations.renderToDOM).toHaveBeenCalledWith(
        expect.objectContaining({
          forceRemount: false,
          storyContext: expect.objectContaining({
            initialArgs: { foo: 'a' },
            args: { foo: 'a' },
          }),
        }),
        undefined // this is coming from view.prepareForStory, not super important
      );
      expect(mockChannel.emit).toHaveBeenCalledWith(Events.STORY_ARGS_UPDATED, {
        storyId: 'component-one--a',
        args: { foo: 'a' },
      });
    });
  });

  describe('on FORCE_RE_RENDER', () => {
    it('rerenders the story with the same args', async () => {
      document.location.search = '?id=component-one--a';
      const preview = new PreviewWeb();
      await preview.initialize({ importFn, getProjectAnnotations });
      await waitForRender();

      mockChannel.emit.mockClear();
      projectAnnotations.renderToDOM.mockClear();
      emitter.emit(Events.FORCE_RE_RENDER);
      await waitForRender();

      expect(projectAnnotations.renderToDOM).toHaveBeenCalledWith(
        expect.objectContaining({ forceRemount: false }),
        undefined // this is coming from view.prepareForStory, not super important
      );
    });
  });

  describe('onSetCurrentStory', () => {
    it('updates URL', async () => {
      document.location.search = '?id=component-one--a';
      await new PreviewWeb().initialize({ importFn, getProjectAnnotations });

      emitter.emit(Events.SET_CURRENT_STORY, {
        storyId: 'component-one--b',
        viewMode: 'story',
      });

      expect(history.replaceState).toHaveBeenCalledWith(
        {},
        '',
        'pathname?id=component-one--b&viewMode=story'
      );
    });

    it('emits CURRENT_STORY_WAS_SET', async () => {
      document.location.search = '?id=component-one--a';
      await new PreviewWeb().initialize({ importFn, getProjectAnnotations });

      emitter.emit(Events.SET_CURRENT_STORY, {
        storyId: 'component-one--b',
        viewMode: 'story',
      });

      expect(mockChannel.emit).toHaveBeenCalledWith(Events.CURRENT_STORY_WAS_SET, {
        storyId: 'component-one--b',
        viewMode: 'story',
      });
    });

    it('renders missing if the story specified does not exist', async () => {
      document.location.search = '?id=component-one--a';
      const preview = new PreviewWeb();
      await preview.initialize({ importFn, getProjectAnnotations });

      emitter.emit(Events.SET_CURRENT_STORY, {
        storyId: 'random',
        viewMode: 'story',
      });

      await waitForEvents([Events.STORY_MISSING]);
      expect(preview.view.showNoPreview).toHaveBeenCalled();
      expect(mockChannel.emit).toHaveBeenCalledWith(Events.STORY_MISSING, 'random');
    });

    describe('if the selection is unchanged', () => {
      it('emits STORY_UNCHANGED', async () => {
        document.location.search = '?id=component-one--a';
        const preview = new PreviewWeb();
        await preview.initialize({ importFn, getProjectAnnotations });

        emitter.emit(Events.SET_CURRENT_STORY, {
          storyId: 'component-one--a',
          viewMode: 'story',
        });

        await waitForEvents([Events.STORY_UNCHANGED]);
        expect(mockChannel.emit).toHaveBeenCalledWith(Events.STORY_UNCHANGED, 'component-one--a');
      });

      it('does NOT call renderToDOM', async () => {
        document.location.search = '?id=component-one--a';
        const preview = new PreviewWeb();
        await preview.initialize({ importFn, getProjectAnnotations });

        projectAnnotations.renderToDOM.mockClear();

        emitter.emit(Events.SET_CURRENT_STORY, {
          storyId: 'component-one--a',
          viewMode: 'story',
        });

        // The renderToDOM would have been async so we need to wait a tick.
        await waitForQuiescence();
        expect(projectAnnotations.renderToDOM).not.toHaveBeenCalled();
      });
    });

    describe('when changing story in story viewMode', () => {
      it('updates URL', async () => {
        document.location.search = '?id=component-one--a';
        await new PreviewWeb().initialize({ importFn, getProjectAnnotations });

        emitter.emit(Events.SET_CURRENT_STORY, {
          storyId: 'component-one--b',
          viewMode: 'story',
        });

        expect(history.replaceState).toHaveBeenCalledWith(
          {},
          '',
          'pathname?id=component-one--b&viewMode=story'
        );
      });

      it('emits STORY_CHANGED', async () => {
        document.location.search = '?id=component-one--a';
        await new PreviewWeb().initialize({ importFn, getProjectAnnotations });
        await waitForRender();

        mockChannel.emit.mockClear();
        emitter.emit(Events.SET_CURRENT_STORY, {
          storyId: 'component-one--b',
          viewMode: 'story',
        });

        await waitForEvents([Events.STORY_CHANGED]);
        expect(mockChannel.emit).toHaveBeenCalledWith(Events.STORY_CHANGED, 'component-one--b');
      });

      it('emits STORY_PREPARED', async () => {
        document.location.search = '?id=component-one--a';
        await new PreviewWeb().initialize({ importFn, getProjectAnnotations });
        await waitForRender();

        mockChannel.emit.mockClear();
        emitter.emit(Events.SET_CURRENT_STORY, {
          storyId: 'component-one--b',
          viewMode: 'story',
        });

        await waitForEvents([Events.STORY_PREPARED]);
        expect(mockChannel.emit).toHaveBeenCalledWith(Events.STORY_PREPARED, {
          id: 'component-one--b',
          parameters: { __isArgsStory: false, docs: { container: expect.any(Function) } },
          initialArgs: { foo: 'b' },
          argTypes: { foo: { name: 'foo', type: { name: 'string' } } },
          args: { foo: 'b' },
        });
      });

      it('applies loaders with story context', async () => {
        document.location.search = '?id=component-one--a';
        await new PreviewWeb().initialize({ importFn, getProjectAnnotations });
        await waitForRender();

        mockChannel.emit.mockClear();
        emitter.emit(Events.SET_CURRENT_STORY, {
          storyId: 'component-one--b',
          viewMode: 'story',
        });

        await waitForRender();
        expect(componentOneExports.default.loaders[0]).toHaveBeenCalledWith(
          expect.objectContaining({
            id: 'component-one--b',
            parameters: { __isArgsStory: false, docs: { container: expect.any(Function) } },
            initialArgs: { foo: 'b' },
            argTypes: { foo: { name: 'foo', type: { name: 'string' } } },
            args: { foo: 'b' },
          })
        );
      });

      it('passes loaded context to renderToDOM', async () => {
        document.location.search = '?id=component-one--a';
        await new PreviewWeb().initialize({ importFn, getProjectAnnotations });
        await waitForRender();

        mockChannel.emit.mockClear();
        emitter.emit(Events.SET_CURRENT_STORY, {
          storyId: 'component-one--b',
          viewMode: 'story',
        });
        await waitForRender();

        expect(projectAnnotations.renderToDOM).toHaveBeenCalledWith(
          expect.objectContaining({
            forceRemount: true,
            storyContext: expect.objectContaining({
              id: 'component-one--b',
              parameters: { __isArgsStory: false, docs: { container: expect.any(Function) } },
              globals: { a: 'b' },
              initialArgs: { foo: 'b' },
              argTypes: { foo: { name: 'foo', type: { name: 'string' } } },
              args: { foo: 'b' },
              loaded: { l: 7 },
            }),
          }),
          undefined // this is coming from view.prepareForStory, not super important
        );
      });

      it('renders exception if renderToDOM throws', async () => {
        document.location.search = '?id=component-one--a';
        const preview = new PreviewWeb();
        await preview.initialize({ importFn, getProjectAnnotations });
        await waitForRender();

        const error = new Error('error');
        projectAnnotations.renderToDOM.mockImplementationOnce(() => {
          throw error;
        });

        mockChannel.emit.mockClear();
        emitter.emit(Events.SET_CURRENT_STORY, {
          storyId: 'component-one--b',
          viewMode: 'story',
        });
        await waitForRender();

        expect(mockChannel.emit).toHaveBeenCalledWith(Events.STORY_THREW_EXCEPTION, error);
        expect(preview.view.showErrorDisplay).toHaveBeenCalledWith(error);
      });

      it('renders error if the story calls showError', async () => {
        document.location.search = '?id=component-one--a';
        const preview = new PreviewWeb();
        await preview.initialize({ importFn, getProjectAnnotations });
        await waitForRender();

        const error = { title: 'title', description: 'description' };
        projectAnnotations.renderToDOM.mockImplementationOnce((context) =>
          context.showError(error)
        );

        mockChannel.emit.mockClear();
        emitter.emit(Events.SET_CURRENT_STORY, {
          storyId: 'component-one--b',
          viewMode: 'story',
        });
        await waitForRender();

        expect(mockChannel.emit).toHaveBeenCalledWith(Events.STORY_ERRORED, error);
        expect(preview.view.showErrorDisplay).toHaveBeenCalledWith({
          message: error.title,
          stack: error.description,
        });
      });

      it('renders exception if the story calls showException', async () => {
        document.location.search = '?id=component-one--a';
        const preview = new PreviewWeb();
        await preview.initialize({ importFn, getProjectAnnotations });
        await waitForRender();

        const error = new Error('error');
        projectAnnotations.renderToDOM.mockImplementationOnce((context) =>
          context.showException(error)
        );

        mockChannel.emit.mockClear();
        emitter.emit(Events.SET_CURRENT_STORY, {
          storyId: 'component-one--b',
          viewMode: 'story',
        });
        await waitForRender();

        expect(mockChannel.emit).toHaveBeenCalledWith(Events.STORY_THREW_EXCEPTION, error);
        expect(preview.view.showErrorDisplay).toHaveBeenCalledWith(error);
      });

      it('executes runPlayFunction', async () => {
        document.location.search = '?id=component-one--a';
        await new PreviewWeb().initialize({ importFn, getProjectAnnotations });
        await waitForRender();

        mockChannel.emit.mockClear();
        emitter.emit(Events.SET_CURRENT_STORY, {
          storyId: 'component-one--b',
          viewMode: 'story',
        });
        await waitForRender();

        expect(componentOneExports.b.play).toHaveBeenCalled();
      });

      it('emits STORY_RENDERED', async () => {
        document.location.search = '?id=component-one--a';
        await new PreviewWeb().initialize({ importFn, getProjectAnnotations });
        await waitForRender();

        mockChannel.emit.mockClear();
        emitter.emit(Events.SET_CURRENT_STORY, {
          storyId: 'component-one--b',
          viewMode: 'story',
        });
        await waitForRender();

        expect(mockChannel.emit).toHaveBeenCalledWith(Events.STORY_RENDERED, 'component-one--b');
      });

      it('retains any arg changes', async () => {
        document.location.search = '?id=component-one--a';
        const preview = new PreviewWeb();
        await preview.initialize({ importFn, getProjectAnnotations });
        await waitForRender();

        mockChannel.emit.mockClear();
        emitter.emit(Events.UPDATE_STORY_ARGS, {
          storyId: 'component-one--a',
          updatedArgs: { foo: 'updated' },
        });
        await waitForRender();
        expect(preview.storyStore.args.get('component-one--a')).toEqual({
          foo: 'updated',
        });

        mockChannel.emit.mockClear();
        emitter.emit(Events.SET_CURRENT_STORY, {
          storyId: 'component-one--b',
          viewMode: 'story',
        });
        await waitForRender();
        expect(preview.storyStore.args.get('component-one--a')).toEqual({
          foo: 'updated',
        });

        mockChannel.emit.mockClear();
        emitter.emit(Events.SET_CURRENT_STORY, {
          storyId: 'component-one--a',
          viewMode: 'story',
        });
        await waitForRender();
        expect(preview.storyStore.args.get('component-one--a')).toEqual({
          foo: 'updated',
        });
      });

      describe('while story is still rendering', () => {
        it('stops initial story after loaders if running', async () => {
          const [gate, openGate] = createGate();
          componentOneExports.default.loaders[0].mockImplementationOnce(async () => gate);

          document.location.search = '?id=component-one--a';
          await new PreviewWeb().initialize({ importFn, getProjectAnnotations });

          emitter.emit(Events.SET_CURRENT_STORY, {
            storyId: 'component-one--b',
            viewMode: 'story',
          });
          await waitForRender();

          // Now let the loader resolve
          openGate({ l: 8 });
          await waitForRender();

          // Story gets rendered with updated args
          expect(projectAnnotations.renderToDOM).toHaveBeenCalledTimes(1);
          expect(projectAnnotations.renderToDOM).toHaveBeenCalledWith(
            expect.objectContaining({
              forceRemount: true,
              storyContext: expect.objectContaining({
                id: 'component-one--b',
                loaded: { l: 7 },
              }),
            }),
            undefined // this is coming from view.prepareForStory, not super important
          );
        });

        it('stops initial story after renderToDOM if running', async () => {
          const [gate, openGate] = createGate();

          document.location.search = '?id=component-one--a';
          projectAnnotations.renderToDOM.mockImplementationOnce(async () => gate);
          await new PreviewWeb().initialize({ importFn, getProjectAnnotations });

          emitter.emit(Events.SET_CURRENT_STORY, {
            storyId: 'component-one--b',
            viewMode: 'story',
          });
          await waitForRender();

          // Now let the renderToDOM call resolve
          openGate();

          expect(projectAnnotations.renderToDOM).toHaveBeenCalledTimes(2);
          expect(componentOneExports.a.play).not.toHaveBeenCalled();
          expect(componentOneExports.b.play).toHaveBeenCalled();

          expect(mockChannel.emit).not.toHaveBeenCalledWith(
            Events.STORY_RENDERED,
            'component-one--a'
          );
          expect(mockChannel.emit).toHaveBeenCalledWith(Events.STORY_RENDERED, 'component-one--b');
        });

        it('stops initial story after runPlayFunction if running', async () => {
          const [gate, openGate] = createGate();
          componentOneExports.a.play.mockImplementationOnce(async () => gate);

          const renderToDOMCalled = new Promise((resolve) => {
            projectAnnotations.renderToDOM.mockImplementationOnce(() => {
              resolve(null);
            });
          });

          document.location.search = '?id=component-one--a';
          await new PreviewWeb().initialize({ importFn, getProjectAnnotations });

          await renderToDOMCalled;
          // Story gets rendered with original args
          expect(projectAnnotations.renderToDOM).toHaveBeenCalledWith(
            expect.objectContaining({
              forceRemount: true,
              storyContext: expect.objectContaining({
                id: 'component-one--a',
                loaded: { l: 7 },
              }),
            }),
            undefined // this is coming from view.prepareForStory, not super important
          );

          emitter.emit(Events.SET_CURRENT_STORY, {
            storyId: 'component-one--b',
            viewMode: 'story',
          });
          await waitForRender();

          // New story gets rendered, (play function is still running)
          expect(projectAnnotations.renderToDOM).toHaveBeenCalledWith(
            expect.objectContaining({
              forceRemount: true,
              storyContext: expect.objectContaining({
                id: 'component-one--b',
                loaded: { l: 7 },
              }),
            }),
            undefined // this is coming from view.prepareForStory, not super important
          );

          // Now let the runPlayFunction call resolve
          openGate();

          // Final story rendered is not emitted for the first story
          await waitForQuiescence();
          expect(mockChannel.emit).not.toHaveBeenCalledWith(
            Events.STORY_RENDERED,
            'component-one--a'
          );
        });
      });
    });

    describe('when changing from story viewMode to docs', () => {
      it('updates URL', async () => {
        document.location.search = '?id=component-one--a';
        await new PreviewWeb().initialize({ importFn, getProjectAnnotations });

        emitter.emit(Events.SET_CURRENT_STORY, {
          storyId: 'component-one--a',
          viewMode: 'docs',
        });

        expect(history.replaceState).toHaveBeenCalledWith(
          {},
          '',
          'pathname?id=component-one--a&viewMode=docs'
        );
      });

      it('emits STORY_CHANGED', async () => {
        document.location.search = '?id=component-one--a';
        await new PreviewWeb().initialize({ importFn, getProjectAnnotations });
        await waitForRender();

        mockChannel.emit.mockClear();
        emitter.emit(Events.SET_CURRENT_STORY, {
          storyId: 'component-one--a',
          viewMode: 'docs',
        });

        await waitForEvents([Events.STORY_CHANGED]);
        expect(mockChannel.emit).toHaveBeenCalledWith(Events.STORY_CHANGED, 'component-one--a');
      });

      it('calls view.prepareForDocs', async () => {
        document.location.search = '?id=component-one--a';
        const preview = new PreviewWeb();
        await preview.initialize({ importFn, getProjectAnnotations });
        await waitForRender();

        mockChannel.emit.mockClear();
        emitter.emit(Events.SET_CURRENT_STORY, {
          storyId: 'component-one--a',
          viewMode: 'docs',
        });
        await waitForRender();

        expect(preview.view.prepareForDocs).toHaveBeenCalled();
      });

      it('render the docs container with the correct context', async () => {
        document.location.search = '?id=component-one--a';
        await new PreviewWeb().initialize({ importFn, getProjectAnnotations });
        await waitForRender();

        mockChannel.emit.mockClear();
        emitter.emit(Events.SET_CURRENT_STORY, {
          storyId: 'component-one--a',
          viewMode: 'docs',
        });
        await waitForRender();

        expect(ReactDOM.render).toHaveBeenCalledWith(
          expect.objectContaining({
            type: componentOneExports.default.parameters.docs.container,
            props: expect.objectContaining({
              context: expect.objectContaining({
                id: 'component-one--a',
                title: 'Component One',
                name: 'A',
              }),
            }),
          }),
          undefined,
          expect.any(Function)
        );
      });

      it('emits DOCS_RENDERED', async () => {
        document.location.search = '?id=component-one--a';
        await new PreviewWeb().initialize({ importFn, getProjectAnnotations });
        await waitForRender();

        mockChannel.emit.mockClear();
        emitter.emit(Events.SET_CURRENT_STORY, {
          storyId: 'component-one--a',
          viewMode: 'docs',
        });
        await waitForRender();

        expect(mockChannel.emit).toHaveBeenCalledWith(Events.DOCS_RENDERED, 'component-one--a');
      });
    });

    describe('when changing from docs viewMode to story', () => {
      it('updates URL', async () => {
        document.location.search = '?id=component-one--a&viewMode=docs';
        await new PreviewWeb().initialize({ importFn, getProjectAnnotations });

        emitter.emit(Events.SET_CURRENT_STORY, {
          storyId: 'component-one--a',
          viewMode: 'story',
        });

        expect(history.replaceState).toHaveBeenCalledWith(
          {},
          '',
          'pathname?id=component-one--a&viewMode=story'
        );
      });

      it('unmounts docs', async () => {
        document.location.search = '?id=component-one--a&viewMode=docs';
        await new PreviewWeb().initialize({ importFn, getProjectAnnotations });
        await waitForRender();

        mockChannel.emit.mockClear();
        emitter.emit(Events.SET_CURRENT_STORY, {
          storyId: 'component-one--a',
          viewMode: 'story',
        });
        await waitForRender();

        expect(ReactDOM.unmountComponentAtNode).toHaveBeenCalled();
      });

      // NOTE: I am not sure this entirely makes sense but this is the behaviour from 6.3
      it('emits STORY_CHANGED', async () => {
        document.location.search = '?id=component-one--a&viewMode=docs';
        await new PreviewWeb().initialize({ importFn, getProjectAnnotations });
        await waitForRender();

        mockChannel.emit.mockClear();
        emitter.emit(Events.SET_CURRENT_STORY, {
          storyId: 'component-one--a',
          viewMode: 'story',
        });

        await waitForEvents([Events.STORY_CHANGED]);
        expect(mockChannel.emit).toHaveBeenCalledWith(Events.STORY_CHANGED, 'component-one--a');
      });

      it('calls view.prepareForStory', async () => {
        document.location.search = '?id=component-one--a&viewMode=docs';
        const preview = new PreviewWeb();
        await preview.initialize({ importFn, getProjectAnnotations });
        await waitForRender();

        mockChannel.emit.mockClear();
        emitter.emit(Events.SET_CURRENT_STORY, {
          storyId: 'component-one--a',
          viewMode: 'story',
        });
        await waitForRender();

        expect(preview.view.prepareForStory).toHaveBeenCalledWith(
          expect.objectContaining({
            id: 'component-one--a',
          })
        );
      });

      it('emits STORY_PREPARED', async () => {
        document.location.search = '?id=component-one--a&viewMode=docs';
        await new PreviewWeb().initialize({ importFn, getProjectAnnotations });
        await waitForRender();

        mockChannel.emit.mockClear();
        emitter.emit(Events.SET_CURRENT_STORY, {
          storyId: 'component-one--a',
          viewMode: 'story',
        });

        await waitForEvents([Events.STORY_PREPARED]);
        expect(mockChannel.emit).toHaveBeenCalledWith(Events.STORY_PREPARED, {
          id: 'component-one--a',
          parameters: { __isArgsStory: false, docs: { container: expect.any(Function) } },
          initialArgs: { foo: 'a' },
          argTypes: { foo: { name: 'foo', type: { name: 'string' } } },
          args: { foo: 'a' },
        });
      });

      it('applies loaders with story context', async () => {
        document.location.search = '?id=component-one--a&viewMode=docs';
        await new PreviewWeb().initialize({ importFn, getProjectAnnotations });
        await waitForRender();

        mockChannel.emit.mockClear();
        emitter.emit(Events.SET_CURRENT_STORY, {
          storyId: 'component-one--a',
          viewMode: 'story',
        });

        await waitForRender();
        expect(componentOneExports.default.loaders[0]).toHaveBeenCalledWith(
          expect.objectContaining({
            id: 'component-one--a',
            parameters: { __isArgsStory: false, docs: { container: expect.any(Function) } },
            initialArgs: { foo: 'a' },
            argTypes: { foo: { name: 'foo', type: { name: 'string' } } },
            args: { foo: 'a' },
          })
        );
      });

      it('passes loaded context to renderToDOM', async () => {
        document.location.search = '?id=component-one--a&viewMode=docs';
        await new PreviewWeb().initialize({ importFn, getProjectAnnotations });
        await waitForRender();

        mockChannel.emit.mockClear();
        emitter.emit(Events.SET_CURRENT_STORY, {
          storyId: 'component-one--a',
          viewMode: 'story',
        });
        await waitForRender();

        expect(projectAnnotations.renderToDOM).toHaveBeenCalledWith(
          expect.objectContaining({
            forceRemount: true,
            storyContext: expect.objectContaining({
              id: 'component-one--a',
              parameters: { __isArgsStory: false, docs: { container: expect.any(Function) } },
              globals: { a: 'b' },
              initialArgs: { foo: 'a' },
              argTypes: { foo: { name: 'foo', type: { name: 'string' } } },
              args: { foo: 'a' },
              loaded: { l: 7 },
            }),
          }),
          undefined // this is coming from view.prepareForStory, not super important
        );
      });

      it('renders exception if renderToDOM throws', async () => {
        document.location.search = '?id=component-one--a&viewMode=docs';
        const preview = new PreviewWeb();
        await preview.initialize({ importFn, getProjectAnnotations });
        await waitForRender();

        const error = new Error('error');
        projectAnnotations.renderToDOM.mockImplementationOnce(() => {
          throw error;
        });

        mockChannel.emit.mockClear();
        emitter.emit(Events.SET_CURRENT_STORY, {
          storyId: 'component-one--a',
          viewMode: 'story',
        });
        await waitForRender();

        expect(mockChannel.emit).toHaveBeenCalledWith(Events.STORY_THREW_EXCEPTION, error);
        expect(preview.view.showErrorDisplay).toHaveBeenCalledWith(error);
      });

      it('renders error if the story calls showError', async () => {
        const error = { title: 'title', description: 'description' };
        projectAnnotations.renderToDOM.mockImplementationOnce((context) =>
          context.showError(error)
        );

        document.location.search = '?id=component-one--a&viewMode=docs';
        const preview = new PreviewWeb();
        await preview.initialize({ importFn, getProjectAnnotations });
        await waitForRender();

        mockChannel.emit.mockClear();
        emitter.emit(Events.SET_CURRENT_STORY, {
          storyId: 'component-one--a',
          viewMode: 'story',
        });
        await waitForRender();

        expect(mockChannel.emit).toHaveBeenCalledWith(Events.STORY_ERRORED, error);
        expect(preview.view.showErrorDisplay).toHaveBeenCalledWith({
          message: error.title,
          stack: error.description,
        });
      });

      it('renders exception if the story calls showException', async () => {
        const error = new Error('error');
        projectAnnotations.renderToDOM.mockImplementationOnce((context) =>
          context.showException(error)
        );

        document.location.search = '?id=component-one--a&viewMode=docs';
        const preview = new PreviewWeb();
        await preview.initialize({ importFn, getProjectAnnotations });
        await waitForRender();

        mockChannel.emit.mockClear();
        emitter.emit(Events.SET_CURRENT_STORY, {
          storyId: 'component-one--a',
          viewMode: 'story',
        });
        await waitForRender();

        expect(mockChannel.emit).toHaveBeenCalledWith(Events.STORY_THREW_EXCEPTION, error);
        expect(preview.view.showErrorDisplay).toHaveBeenCalledWith(error);
      });

      it('executes runPlayFunction', async () => {
        document.location.search = '?id=component-one--a&viewMode=docs';
        await new PreviewWeb().initialize({ importFn, getProjectAnnotations });
        await waitForRender();

        mockChannel.emit.mockClear();
        emitter.emit(Events.SET_CURRENT_STORY, {
          storyId: 'component-one--a',
          viewMode: 'story',
        });
        await waitForRender();

        expect(componentOneExports.a.play).toHaveBeenCalled();
      });

      it('emits STORY_RENDERED', async () => {
        document.location.search = '?id=component-one--a&viewMode=docs';
        await new PreviewWeb().initialize({ importFn, getProjectAnnotations });
        await waitForRender();

        mockChannel.emit.mockClear();
        emitter.emit(Events.SET_CURRENT_STORY, {
          storyId: 'component-one--a',
          viewMode: 'story',
        });
        await waitForRender();

        expect(mockChannel.emit).toHaveBeenCalledWith(Events.STORY_RENDERED, 'component-one--a');
      });
    });
  });

  describe('onStoriesChanged', () => {
    describe('when the current story changes', () => {
      const newComponentOneExports = merge({}, componentOneExports, {
        a: { args: { foo: 'edited' } },
      });
      const newImportFn = jest.fn(async (path) => {
        return path === './src/ComponentOne.stories.js'
          ? newComponentOneExports
          : componentTwoExports;
      });

      it('does not emit STORY_UNCHANGED', async () => {
        document.location.search = '?id=component-one--a';
        const preview = new PreviewWeb();
        await preview.initialize({ importFn, getProjectAnnotations });
        await waitForRender();
        mockChannel.emit.mockClear();

        preview.onStoriesChanged({ importFn: newImportFn });
        await waitForRender();

        expect(mockChannel.emit).not.toHaveBeenCalledWith(
          Events.STORY_UNCHANGED,
          'component-one--a'
        );
      });

      it('does not emit STORY_CHANGED', async () => {
        document.location.search = '?id=component-one--a';
        const preview = new PreviewWeb();
        await preview.initialize({ importFn, getProjectAnnotations });
        await waitForRender();
        mockChannel.emit.mockClear();

        preview.onStoriesChanged({ importFn: newImportFn });
        await waitForRender();

        expect(mockChannel.emit).not.toHaveBeenCalledWith(Events.STORY_CHANGED, 'component-one--a');
      });

      it('emits STORY_PREPARED with new annotations', async () => {
        document.location.search = '?id=component-one--a';
        const preview = new PreviewWeb();
        await preview.initialize({ importFn, getProjectAnnotations });
        await waitForRender();
        mockChannel.emit.mockClear();

        preview.onStoriesChanged({ importFn: newImportFn });
        await waitForRender();

        expect(mockChannel.emit).toHaveBeenCalledWith(Events.STORY_PREPARED, {
          id: 'component-one--a',
          parameters: { __isArgsStory: false, docs: { container: expect.any(Function) } },
          initialArgs: { foo: 'edited' },
          argTypes: { foo: { name: 'foo', type: { name: 'string' } } },
          args: { foo: 'edited' },
        });
      });

      it('applies loaders with story context', async () => {
        document.location.search = '?id=component-one--a';
        const preview = new PreviewWeb();
        await preview.initialize({ importFn, getProjectAnnotations });
        await waitForRender();

        mockChannel.emit.mockClear();
        componentOneExports.default.loaders[0].mockClear();
        preview.onStoriesChanged({ importFn: newImportFn });
        await waitForRender();

        expect(componentOneExports.default.loaders[0]).toHaveBeenCalledWith(
          expect.objectContaining({
            id: 'component-one--a',
            parameters: { __isArgsStory: false, docs: { container: expect.any(Function) } },
            initialArgs: { foo: 'edited' },
            argTypes: { foo: { name: 'foo', type: { name: 'string' } } },
            args: { foo: 'edited' },
          })
        );
      });

      it('passes loaded context to renderToDOM', async () => {
        document.location.search = '?id=component-one--a';
        const preview = new PreviewWeb();
        await preview.initialize({ importFn, getProjectAnnotations });
        await waitForRender();

        mockChannel.emit.mockClear();
        projectAnnotations.renderToDOM.mockClear();
        preview.onStoriesChanged({ importFn: newImportFn });
        await waitForRender();

        expect(projectAnnotations.renderToDOM).toHaveBeenCalledWith(
          expect.objectContaining({
            forceRemount: true,
            storyContext: expect.objectContaining({
              id: 'component-one--a',
              parameters: { __isArgsStory: false, docs: { container: expect.any(Function) } },
              globals: { a: 'b' },
              initialArgs: { foo: 'edited' },
              argTypes: { foo: { name: 'foo', type: { name: 'string' } } },
              args: { foo: 'edited' },
              loaded: { l: 7 },
            }),
          }),
          undefined // this is coming from view.prepareForStory, not super important
        );
      });

      it('retains the same delta to the args', async () => {
        document.location.search = '?id=component-one--a';
        const preview = new PreviewWeb();
        await preview.initialize({ importFn, getProjectAnnotations });
        await waitForRender();

        emitter.emit(Events.UPDATE_STORY_ARGS, {
          storyId: 'component-one--a',
          updatedArgs: { foo: 'updated' },
        });
        await waitForRender();

        mockChannel.emit.mockClear();
        projectAnnotations.renderToDOM.mockClear();
        preview.onStoriesChanged({ importFn: newImportFn });
        await waitForRender();

        expect(projectAnnotations.renderToDOM).toHaveBeenCalledWith(
          expect.objectContaining({
            forceRemount: true,
            storyContext: expect.objectContaining({
              id: 'component-one--a',
              args: { foo: 'updated' },
            }),
          }),
          undefined // this is coming from view.prepareForStory, not super important
        );
      });

      it('renders exception if renderToDOM throws', async () => {
        document.location.search = '?id=component-one--a';
        const preview = new PreviewWeb();
        await preview.initialize({ importFn, getProjectAnnotations });
        await waitForRender();

        const error = new Error('error');
        projectAnnotations.renderToDOM.mockImplementationOnce(() => {
          throw error;
        });

        mockChannel.emit.mockClear();
        preview.onStoriesChanged({ importFn: newImportFn });
        await waitForRender();

        expect(mockChannel.emit).toHaveBeenCalledWith(Events.STORY_THREW_EXCEPTION, error);
        expect(preview.view.showErrorDisplay).toHaveBeenCalledWith(error);
      });

      it('renders error if the story calls showError', async () => {
        document.location.search = '?id=component-one--a';
        const preview = new PreviewWeb();
        await preview.initialize({ importFn, getProjectAnnotations });
        await waitForRender();

        const error = { title: 'title', description: 'description' };
        projectAnnotations.renderToDOM.mockImplementationOnce((context) =>
          context.showError(error)
        );

        mockChannel.emit.mockClear();
        preview.onStoriesChanged({ importFn: newImportFn });
        await waitForRender();

        expect(mockChannel.emit).toHaveBeenCalledWith(Events.STORY_ERRORED, error);
        expect(preview.view.showErrorDisplay).toHaveBeenCalledWith({
          message: error.title,
          stack: error.description,
        });
      });

      it('renders exception if the story calls showException', async () => {
        document.location.search = '?id=component-one--a';
        const preview = new PreviewWeb();
        await preview.initialize({ importFn, getProjectAnnotations });
        await waitForRender();

        const error = new Error('error');
        projectAnnotations.renderToDOM.mockImplementationOnce((context) =>
          context.showException(error)
        );

        mockChannel.emit.mockClear();
        preview.onStoriesChanged({ importFn: newImportFn });
        await waitForRender();

        expect(mockChannel.emit).toHaveBeenCalledWith(Events.STORY_THREW_EXCEPTION, error);
        expect(preview.view.showErrorDisplay).toHaveBeenCalledWith(error);
      });

      it('executes runPlayFunction', async () => {
        document.location.search = '?id=component-one--a';
        const preview = new PreviewWeb();
        await preview.initialize({ importFn, getProjectAnnotations });
        await waitForRender();

        mockChannel.emit.mockClear();
        componentOneExports.a.play.mockClear();
        preview.onStoriesChanged({ importFn: newImportFn });
        await waitForRender();

        expect(componentOneExports.a.play).toHaveBeenCalled();
      });

      it('emits STORY_RENDERED', async () => {
        document.location.search = '?id=component-one--a';
        const preview = new PreviewWeb();
        await preview.initialize({ importFn, getProjectAnnotations });
        await waitForRender();

        mockChannel.emit.mockClear();
        preview.onStoriesChanged({ importFn: newImportFn });
        await waitForRender();

        expect(mockChannel.emit).toHaveBeenCalledWith(Events.STORY_RENDERED, 'component-one--a');
      });
    });

    describe('when the current story changes importPath', () => {
      const newImportFn = jest.fn(async (path) => ({ ...componentOneExports }));

      const newStoryIndex = {
        v: 3,
        stories: {
          ...storyIndex.stories,
          'component-one--a': {
            ...storyIndex.stories['component-one--a'],
            importPath: './src/ComponentOne-new.stories.js',
          },
        },
      };
      beforeEach(() => {
        newImportFn.mockClear();
      });

      it('re-imports the component', async () => {
        document.location.search = '?id=component-one--a';
        const preview = new PreviewWeb();
        await preview.initialize({ importFn, getProjectAnnotations });
        await waitForRender();

        mockChannel.emit.mockClear();
        preview.onStoriesChanged({ importFn: newImportFn, storyIndex: newStoryIndex });
        await waitForRender();

        expect(newImportFn).toHaveBeenCalledWith('./src/ComponentOne-new.stories.js');
      });

      describe('if it was previously rendered', () => {
        it('is reloaded when it is re-selected', async () => {
          document.location.search = '?id=component-one--a';
          const preview = new PreviewWeb();
          await preview.initialize({ importFn, getProjectAnnotations });
          await waitForRender();

          mockChannel.emit.mockClear();
          emitter.emit(Events.SET_CURRENT_STORY, {
            storyId: 'component-one--b',
            viewMode: 'story',
          });
          await waitForRender();

          preview.onStoriesChanged({ importFn: newImportFn, storyIndex: newStoryIndex });

          mockChannel.emit.mockClear();
          emitter.emit(Events.SET_CURRENT_STORY, {
            storyId: 'component-one--a',
            viewMode: 'story',
          });
          await waitForRender();
          expect(newImportFn).toHaveBeenCalledWith('./src/ComponentOne-new.stories.js');
        });
      });
    });

    describe('when the current story has not changed', () => {
      const newComponentTwoExports = { ...componentTwoExports };
      const newImportFn = jest.fn(async (path) => {
        return path === './src/ComponentOne.stories.js'
          ? componentOneExports
          : newComponentTwoExports;
      });

      it('emits STORY_UNCHANGED', async () => {
        document.location.search = '?id=component-one--a';
        const preview = new PreviewWeb();
        await preview.initialize({ importFn, getProjectAnnotations });
        await waitForRender();

        mockChannel.emit.mockClear();
        preview.onStoriesChanged({ importFn: newImportFn });
        await waitForEvents([Events.STORY_UNCHANGED]);

        expect(mockChannel.emit).toHaveBeenCalledWith(Events.STORY_UNCHANGED, 'component-one--a');
        expect(mockChannel.emit).not.toHaveBeenCalledWith(Events.STORY_CHANGED, 'component-one--a');
      });

      it('does not re-render the story', async () => {
        document.location.search = '?id=component-one--a';
        const preview = new PreviewWeb();
        await preview.initialize({ importFn, getProjectAnnotations });
        await waitForRender();

        mockChannel.emit.mockClear();
        projectAnnotations.renderToDOM.mockClear();
        preview.onStoriesChanged({ importFn: newImportFn });
        await waitForQuiescence();

        expect(projectAnnotations.renderToDOM).not.toHaveBeenCalled();
        expect(mockChannel.emit).not.toHaveBeenCalledWith(
          Events.STORY_RENDERED,
          'component-one--a'
        );
      });
    });

    describe('if the story no longer exists', () => {
      const { a, ...componentOneExportsWithoutA } = componentOneExports;
      const newImportFn = jest.fn(async (path) => {
        return path === './src/ComponentOne.stories.js'
          ? componentOneExportsWithoutA
          : componentTwoExports;
      });

      const newStoryIndex = {
        v: 3,
        stories: {
          'component-one--b': storyIndex.stories['component-one--b'],
        },
      };

      it('renders story missing', async () => {
        document.location.search = '?id=component-one--a';
        const preview = new PreviewWeb();
        await preview.initialize({ importFn, getProjectAnnotations });
        await waitForRender();

        mockChannel.emit.mockClear();
        preview.onStoriesChanged({ importFn: newImportFn, storyIndex: newStoryIndex });
        await waitForEvents([Events.STORY_MISSING]);

        expect(preview.view.showNoPreview).toHaveBeenCalled();
        expect(mockChannel.emit).toHaveBeenCalledWith(Events.STORY_MISSING, 'component-one--a');
      });

      it('does not re-render the story', async () => {
        document.location.search = '?id=component-one--a';
        const preview = new PreviewWeb();
        await preview.initialize({ importFn, getProjectAnnotations });
        await waitForRender();

        mockChannel.emit.mockClear();
        projectAnnotations.renderToDOM.mockClear();
        preview.onStoriesChanged({ importFn: newImportFn, storyIndex: newStoryIndex });
        await waitForQuiescence();

        expect(projectAnnotations.renderToDOM).not.toHaveBeenCalled();
        expect(mockChannel.emit).not.toHaveBeenCalledWith(
          Events.STORY_RENDERED,
          'component-one--a'
        );
      });

      it('re-renders the story if it is readded', async () => {
        document.location.search = '?id=component-one--a';
        const preview = new PreviewWeb();
        await preview.initialize({ importFn, getProjectAnnotations });
        await waitForRender();

        mockChannel.emit.mockClear();
        preview.onStoriesChanged({ importFn: newImportFn, storyIndex: newStoryIndex });
        await waitForEvents([Events.STORY_MISSING]);

        mockChannel.emit.mockClear();
        preview.onStoriesChanged({ importFn, storyIndex });
        await waitForRender();
        expect(mockChannel.emit).toHaveBeenCalledWith(Events.STORY_RENDERED, 'component-one--a');
      });
    });
  });

  describe('onGetProjectAnnotationsChanged', () => {
    it('shows an error the new value throws', async () => {
      document.location.search = '?id=component-one--a';
      const preview = new PreviewWeb();
      await preview.initialize({ importFn, getProjectAnnotations });
      await waitForRender();

      mockChannel.emit.mockClear();
      const err = new Error('error getting meta');
      preview.onGetProjectAnnotationsChanged({
        getProjectAnnotations: () => {
          throw err;
        },
      });

      expect(preview.view.showErrorDisplay).toHaveBeenCalled();
      expect(mockChannel.emit).toHaveBeenCalledWith(Events.CONFIG_ERROR, err);
    });

    const newGlobalDecorator = jest.fn((s) => s());
    const newGetGlobalMeta = () => {
      return {
        ...projectAnnotations,
        args: { global: 'added' },
        globals: { a: 'edited' },
        decorators: [newGlobalDecorator],
      };
    };

    it('updates globals to their new values', async () => {
      document.location.search = '?id=component-one--a';
      const preview = new PreviewWeb();
      await preview.initialize({ importFn, getProjectAnnotations });
      await waitForRender();

      mockChannel.emit.mockClear();
      preview.onGetProjectAnnotationsChanged({ getProjectAnnotations: newGetGlobalMeta });
      await waitForRender();

      expect(preview.storyStore.globals.get()).toEqual({ a: 'edited' });
    });

    it('updates args to their new values', async () => {
      document.location.search = '?id=component-one--a';
      const preview = new PreviewWeb();
      await preview.initialize({ importFn, getProjectAnnotations });
      await waitForRender();

      mockChannel.emit.mockClear();
      preview.onGetProjectAnnotationsChanged({ getProjectAnnotations: newGetGlobalMeta });

      await waitForRender();

      expect(preview.storyStore.args.get('component-one--a')).toEqual({
        foo: 'a',
        global: 'added',
      });
    });

    it('rerenders the current story with new global meta-generated context', async () => {
      document.location.search = '?id=component-one--a';
      const preview = new PreviewWeb();
      await preview.initialize({ importFn, getProjectAnnotations });
      await waitForRender();

      projectAnnotations.renderToDOM.mockClear();
      mockChannel.emit.mockClear();
      preview.onGetProjectAnnotationsChanged({ getProjectAnnotations: newGetGlobalMeta });
      await waitForRender();

      expect(projectAnnotations.renderToDOM).toHaveBeenCalledWith(
        expect.objectContaining({
          storyContext: expect.objectContaining({
            args: { foo: 'a', global: 'added' },
            globals: { a: 'edited' },
          }),
        }),
        undefined // this is coming from view.prepareForStory, not super important
      );
    });
  });

  describe('onKeydown', () => {
    it('emits PREVIEW_KEYDOWN for regular elements', async () => {
      document.location.search = '?id=component-one--a&viewMode=docs';
      const preview = new PreviewWeb();
      await preview.initialize({ importFn, getProjectAnnotations });

      preview.onKeydown({
        target: { tagName: 'div', getAttribute: jest.fn().mockReturnValue(null) },
      } as any);

      expect(mockChannel.emit).toHaveBeenCalledWith(
        Events.PREVIEW_KEYDOWN,
        expect.objectContaining({})
      );
    });

    it('does not emit PREVIEW_KEYDOWN for input elements', async () => {
      document.location.search = '?id=component-one--a&viewMode=docs';
      const preview = new PreviewWeb();
      await preview.initialize({ importFn, getProjectAnnotations });

      preview.onKeydown({
        target: { tagName: 'input', getAttribute: jest.fn().mockReturnValue(null) },
      } as any);

      expect(mockChannel.emit).not.toHaveBeenCalledWith(
        Events.PREVIEW_KEYDOWN,
        expect.objectContaining({})
      );
    });
  });
});
