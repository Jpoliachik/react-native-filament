import React from 'react'
import { FilamentProxy } from '../native/FilamentProxy'
import FilamentNativeView, { type FilamentViewNativeType, type NativeProps } from '../native/specs/FilamentViewNativeComponent'
import { reportWorkletError, wrapWithErrorHandler } from '../ErrorUtils'
import { FilamentContext } from '../hooks/useFilamentContext'
import { RenderCallback, SwapChain } from 'react-native-filament'
import type { SurfaceProvider, FilamentView as RNFFilamentView } from '../native/FilamentViewTypes'
import { Listener } from '../types/Listener'
import { findNodeHandle, GestureResponderEvent } from 'react-native'
import { Worklets } from 'react-native-worklets-core'
import { getLogger } from '../utilities/logger/Logger'
import { getTouchHandlers } from './TouchHandlerContext'

const Logger = getLogger()

export type PublicNativeProps = Omit<NativeProps, 'onViewReady'>

export interface FilamentProps extends PublicNativeProps {
  /**
   * This function will be called every frame. You can use it to update your scene.
   *
   * @note Don't call any methods on `engine` here - this will lead to deadlocks!
   */
  renderCallback: RenderCallback
}

type RefType = InstanceType<FilamentViewNativeType>

let viewIds = 0

/**
 * The component that actually renders the native view and displays our content (think of it as canvas).
 */
export class FilamentView extends React.PureComponent<FilamentProps> {
  private readonly ref: React.RefObject<RefType>
  private surfaceCreatedListener: Listener | undefined
  private surfaceDestroyedListener: Listener | undefined
  private renderCallbackListener: Listener | undefined
  private swapChain: SwapChain | undefined
  private view: RNFFilamentView | undefined
  // There is a race condition where the surface might be destroyed before the swapchain is created.
  // For this we keep track of the surface state:
  private isSurfaceAlive = Worklets.createSharedValue(true)
  private isComponentMounted = false
  private viewId: number

  /**
   * Uses the context in class.
   * @note Not available in the constructor!
   */
  static contextType = FilamentContext
  // @ts-expect-error We can't use the declare keyword here as react-natives metro babel preset isn't able to handle it yet
  context!: React.ContextType<typeof FilamentContext>

  constructor(props: FilamentProps) {
    super(props)
    this.ref = React.createRef<RefType>()
    this.viewId = viewIds++
  }

  private get handle(): number {
    const nodeHandle = findNodeHandle(this.ref.current)
    if (nodeHandle == null || nodeHandle === -1) {
      throw new Error("Could not get the FilamentView's native view tag! Does the FilamentView exist in the native view-tree?")
    }

    return nodeHandle
  }

  private updateTransparentRendering = (enable: boolean) => {
    const { renderer } = this.getContext()
    renderer.setClearContent(enable)
  }

  private latestToken = 0
  private updateRenderCallback = async (callback: RenderCallback, swapChain: SwapChain) => {
    const currentToken = ++this.latestToken
    const { renderer, view, workletContext, choreographer } = this.getContext()

    // When requesting to update the render callback we have to assume that the previous one is not valid anymore
    // ie. its pointing to already released resources from useDisposableResource:
    this.renderCallbackListener?.remove()

    // Adding a new render callback listener is an async operation
    Logger.debug('Setting render callback')
    const listener = await workletContext.runAsync(
      wrapWithErrorHandler(() => {
        'worklet'

        // We need to create the function we pass to addFrameCallbackListener on the worklet thread, so that the
        // underlying JSI function is owned by that thread. Only then can we call it on the worklet thread when
        // the choreographer is calling its listeners.
        return choreographer.addFrameCallbackListener((frameInfo) => {
          'worklet'

          if (!swapChain.isValid) {
            // TODO: Supposedly fixed in https://github.com/margelo/react-native-filament/pull/210, remove this once proven
            reportWorkletError(
              new Error(
                '[react-native-filament] SwapChain is invalid, cannot render frame.\nThis should never happen, please report an issue with reproduction steps.'
              )
            )
            return
          }

          try {
            callback(frameInfo)

            if (renderer.beginFrame(swapChain, frameInfo.timestamp)) {
              renderer.render(view)
              renderer.endFrame()
            }
          } catch (error) {
            reportWorkletError(error)
          }
        })
      })
    )

    // It can happen that after the listener was set the surface got destroyed already:
    if (!this.isComponentMounted || !this.isSurfaceAlive.value) {
      Logger.debug('🚧 Component is already unmounted or surface is no longer alive, removing choreographer listener')
      listener.remove()
      return
    }

    // As setting the listener is async, we have to check updateRenderCallback was called meanwhile.
    // In that case we have to assume that the listener we just set is not valid anymore:
    if (currentToken !== this.latestToken) {
      listener.remove()
      return
    }

    this.renderCallbackListener = listener
    Logger.debug('Render callback set!')

    // Calling this here ensures that only after the latest successful call for attaching a listener, the choreographer is started.
    Logger.debug('Starting choreographer')
    choreographer.start()
  }

  private getContext = () => {
    if (this.context == null) {
      throw new Error('Filament component must be used within a FilamentProvider!')
    }

    return this.context
  }

  componentDidMount(): void {
    Logger.debug('Mounting FilamentView', this.viewId)
    this.isComponentMounted = true
    // Setup transparency mode:
    if (!this.props.enableTransparentRendering) {
      this.updateTransparentRendering(false)
    }
  }

  componentDidUpdate(prevProps: Readonly<FilamentProps>): void {
    if (prevProps.enableTransparentRendering !== this.props.enableTransparentRendering) {
      this.updateTransparentRendering(this.props.enableTransparentRendering ?? true)
    }
    if (prevProps.renderCallback !== this.props.renderCallback && this.swapChain != null) {
      // Note: if swapChain was null, the renderCallback will be set/updated in onSurfaceCreated, which uses the latest renderCallback prop
      this.updateRenderCallback(this.props.renderCallback, this.swapChain)
    }
  }

  /**
   * Calling this signals that this FilamentView will be removed, and it should release all its resources and listeners.
   */
  cleanupResources() {
    Logger.debug('Cleaning up resources')
    const { choreographer } = this.getContext()
    choreographer.stop()

    this.renderCallbackListener?.remove()
    this.isSurfaceAlive.value = false
    this.swapChain?.release()
    this.swapChain = undefined // Note: important to set it to undefined, as this might be called twice (onSurfaceDestroyed and componentWillUnmount), and we can only release once

    // Unlink the view from the choreographer. The native view might be destroyed later, after another FilamentView is created using the same choreographer (and then it would stop the rendering)
    this.view?.setChoreographer(undefined)
  }

  componentWillUnmount(): void {
    Logger.debug('Unmounting FilamentView', this.viewId)
    this.isComponentMounted = false
    this.surfaceCreatedListener?.remove()
    this.surfaceDestroyedListener?.remove()
    this.cleanupResources()
  }

  // This registers the surface provider, which will be notified when the surface is ready to draw on:
  private onViewReady = async () => {
    const context = this.getContext()
    const handle = this.handle
    Logger.debug('Finding FilamentView with handle', handle)
    this.view = await FilamentProxy.findFilamentView(handle)
    if (this.view == null) {
      throw new Error(`Failed to find FilamentView #${handle}!`)
    }
    if (!this.isComponentMounted) {
      // It can happen that while the above async function executed the view was already removed
      Logger.debug('➡️ Component already unmounted, skipping setup')
      return
    }
    Logger.debug('Found FilamentView!')
    // Link the view with the choreographer.
    // When the view gets destroyed, the choreographer will be stopped.
    this.view.setChoreographer(context.choreographer)

    if (this.ref.current == null) {
      throw new Error('Ref is not set!')
    }

    const surfaceProvider = this.view.getSurfaceProvider()
    const filamentDispatcher = FilamentProxy.getCurrentDispatcher()
    this.surfaceCreatedListener = surfaceProvider.addOnSurfaceCreatedListener(() => {
      this.onSurfaceCreated(surfaceProvider)
    }, filamentDispatcher)
    this.surfaceDestroyedListener = surfaceProvider.addOnSurfaceDestroyedListener(() => {
      this.onSurfaceDestroyed()
    }, filamentDispatcher)
    // Link the surface with the engine:
    Logger.debug('Setting surface provider')
    context.engine.setSurfaceProvider(surfaceProvider)
    // Its possible that the surface is already created, then our callback wouldn't be called
    // (we still keep the callback as on android a surface can be destroyed and recreated, while the view stays alive)
    if (surfaceProvider.getSurface() != null) {
      Logger.debug('Surface already created!')
      this.onSurfaceCreated(surfaceProvider)
    }
  }

  // This will be called once the surface is created and ready to draw on:
  private onSurfaceCreated = async (surfaceProvider: SurfaceProvider) => {
    Logger.debug('Surface created!')
    const isSurfaceAlive = this.isSurfaceAlive
    isSurfaceAlive.value = true
    const { engine, workletContext } = this.getContext()
    // Create a swap chain …
    const enableTransparentRendering = this.props.enableTransparentRendering ?? true
    Logger.debug('Creating swap chain')
    const swapChain = await workletContext.runAsync(() => {
      'worklet'

      if (!isSurfaceAlive.value) {
        return null
      }

      try {
        return engine.createSwapChainForSurface(surfaceProvider, enableTransparentRendering)
      } catch (error) {
        // Report this error as none-fatal. We only throw in createSwapChainForSurface if the surface is already released.
        // There is the chance of a race condition where the surface is destroyed but our JS onDestroy listener hasn't been called yet.
        reportWorkletError(error, false)
        return null
      }
    })

    if (swapChain == null) {
      isSurfaceAlive.value = false
      Logger.info('🚧 Swap chain is null, surface was already destroyed while we tried to create a swapchain from it.')
      return
    }
    this.swapChain = swapChain

    // Apply the swapchain to the engine …
    Logger.debug('Setting swap chain')
    engine.setSwapChain(this.swapChain)

    // Set the render callback in the choreographer:
    const { renderCallback } = this.props
    await this.updateRenderCallback(renderCallback, this.swapChain)
  }

  /**
   * On surface destroyed might be called multiple times for the same native view (FilamentView).
   * On android if a surface is destroyed, it can be recreated, while the view stays alive.
   */
  private onSurfaceDestroyed = () => {
    Logger.info('Surface destroyed!')
    this.isSurfaceAlive.value = false
    this.cleanupResources()
  }

  /**
   * Pauses the rendering of the Filament view.
   */
  public pause = (): void => {
    Logger.info('Pausing rendering')
    const { choreographer } = this.getContext()
    choreographer.stop()
  }

  /**
   * Resumes the rendering of the Filament view.
   * It's a no-op if the rendering is already running.
   */
  public resume = (): void => {
    Logger.info('Resuming rendering')
    const { choreographer } = this.getContext()
    choreographer.start()
  }

  private onTouchStart = (event: GestureResponderEvent) => {
    if (this.props.onTouchStart != null) {
      this.props.onTouchStart(event)
    }

    // Gets the registered callbacks from the TouchHandlerContext
    // This way we only have one real gesture responder event handler
    const touchHandlers = getTouchHandlers()
    const callbacks = Object.values(touchHandlers)
    Logger.debug('onTouchStart, handlers count:', callbacks.length)
    for (const handler of callbacks) {
      handler(event)
    }
  }

  /** @internal */
  public render(): React.ReactNode {
    return <FilamentNativeView ref={this.ref} onViewReady={this.onViewReady} {...this.props} onTouchStart={this.onTouchStart} />
  }
}

// @ts-expect-error Not in the types
FilamentView.defaultProps = {
  enableTransparentRendering: true,
}
