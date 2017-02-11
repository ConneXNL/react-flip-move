/**
 * React Flip Move
 * (c) 2016-present Joshua Comeau
 *
 * For information on how this code is laid out, check out CODE_TOUR.md
 */

/* eslint-disable react/prop-types */

import React, { Component } from 'react';

import './polyfills';
import propConverter from './prop-converter';
import {
  applyStylesToDOMNode,
  createTransitionString,
  getNativeNode,
  getPositionDelta,
  getRelativeBoundingBox,
  removeNodeFromDOMFlow,
  updateHeightPlaceholder,
  whichTransitionEvent,
} from './dom-manipulation';
import { arraysEqual } from './helpers';

const transitionEnd = whichTransitionEvent();
const noBrowserSupport = !transitionEnd;

import {ChildStatusTracker} from './child-status-tracker';


class FlipMove extends Component {
  constructor(props) {
    super(props);

    // FlipMove needs to know quite a bit about its children in order to do
    // its job. We store these as a property on the instance. We're not using
    // state, because we don't want changes to trigger re-renders, we just
    // need a place to keep the data for reference, when changes happen.
    this.childrenData = {
      /* Populated via callback refs on render. eg
       userSpecifiedKey1: {
       domNode: <domNode>,
       boundingBox: { top, left, right, bottom, width, height },
       },
       userSpecifiedKey2: { ... },
       ...
       */
    };

    // Similarly, track the dom node and box of our parent element.
    this.parentData = {
      domNode: null,
      boundingBox: null,
    };

    // If `maintainContainerHeight` prop is set to true, we'll create a
    // placeholder element which occupies space so that the parent height
    // doesn't change when items are removed from the document flow (which
    // happens during leave animations)
    this.heightPlaceholderData = {
      domNode: null,
    };

    // This object will contain the status of all children. This is used to keep track
    // of the transition state of each child.
    this.tracker = new ChildStatusTracker();

    // Copy props.children into state.
    // To understand why this is important (and not an anti-pattern), consider
    // how "leave" animations work. An item has "left" when the component
    // receives a new set of props that do NOT contain the item.
    // If we just render the props as-is, the item would instantly disappear.
    // We want to keep the item rendered for a little while, until its animation
    // can complete. Because we cannot mutate props, we make `state` the source
    // of truth.
    const updatedChildren = this.props.children.map((nextChild) => {

      // We are marking all starting children as idle as we expected them
      // to have already entered...
      this.tracker.markAsIdle(nextChild);

      return { ...nextChild };
    });

    this.state = { children: updatedChildren };

    // Keep track of remaining animations so we know when to fire the
    // all-finished callback, and clean up after ourselves.
    // NOTE: we can't simply use childrenToAnimate.length to track remaining
    // animations, because we need to maintain the list of animating children,
    // to pass to the `onFinishAll` handler.
    this.childrenToAnimate = [];

    // This object will contain a map of child keys with some of their styles (transform, opacity)
    // computed before the next render(). This is used to refresh entering/leaving transitions.
    this.styleBeforeRender = {};

    // This object holds all the transitionend handlers.
    this.transitionEndHandlerMap = {};

    // This boolean is set true if during a new render items seem to have changed order / shuffled.
    // This is used to detect whether we want to refresh entering transitions.
    this.childrenHaveShuffled = false;

    // This property will hold a timeout which will cleanup any transitionend triggers that weren't called
    // despite our efforts. This is refreshed on componentDidUpdate and is taking into account stagger, delay
    // and duration including an additional 100ms.
    this.cleanupFallback = null;

    this.doesChildNeedToBeAnimated = this.doesChildNeedToBeAnimated.bind(this);
    this.runAnimation = this.runAnimation.bind(this);
  }

  componentWillUpdate(nextProps, nextState){

    // We are clearing the previous styleBeforeRender as that is now history..
    this.styleBeforeRender = {};

    // We are going to save the current position of items that were already entering and leaving
    // in order to be able to refresh their transition...

    nextState.children.forEach((child) => {

      // We are only saving the current position if the children have shuffled or its a leaving transition...
      if (this.childrenHaveShuffled && (this.tracker.isEntering(child) || this.tracker.isLeaving(child))){

        const childKey = child.key;
        const { domNode } = this.childrenData[childKey];

        if (domNode){
          const {transform, opacity} = getComputedStyle(domNode);

          this.styleBeforeRender[childKey] = {
            transform,
            opacity
          };
        }
      }
    });
  }

  componentWillReceiveProps(nextProps) {
    // When the component is handed new props, we need to figure out the
    // "resting" position of all currently-rendered DOM nodes.
    // We store that data in this.parent and this.children,
    // so it can be used later to work out the animation.
    this.updateBoundingBoxCaches();

    // Next, we need to update our state, so that it contains our new set of
    // children. If animation is disabled or unsupported, this is easy;
    // we just copy our props into state.
    // Assuming that we can animate, though, we have to do some work.
    // Essentially, we want to keep just-deleted nodes in the DOM for a bit
    // longer, so that we can animate them away.

    let newChildren;

    if (this.isAnimationDisabled(nextProps)) {

      // We are clearing the all children' status...
      this.tracker.clear();

      newChildren = nextProps.children.map((nextChild) => {

        // We are marking every existing child as idle...
        // @todo are we sure left children have everything cleaned up?
        this.tracker.markAsIdle(nextChild);
        return {...nextChild};
      });

      this.state.children.forEach((child) => {

        // We are removing any existing transitionend handler...
        const { key } = child;

        if (key) {
          const { domNode } = this.childrenData[child.key];
          this.removeTransitionEndHandler(child.key);
        }

      })

    } else {
      newChildren = this.calculateNextSetOfChildren(nextProps.children);
    }

    this.setState({ children: newChildren });
  }

  componentDidUpdate(previousProps) {
    // If the children have been re-arranged, moved, or added/removed,
    // trigger the main FLIP animation.
    //
    // IMPORTANT: We need to make sure that the children have actually changed.
    // At the end of the transition, we clean up nodes that need to be removed.
    // We DON'T want this cleanup to trigger another update.

    const oldChildrenKeys = this.props.children.map(d => d.key);
    const nextChildrenKeys = previousProps.children.map(d => d.key);

    const shouldTriggerFLIP = (
      !arraysEqual(oldChildrenKeys, nextChildrenKeys) && !this.isAnimationDisabled(this.props)
    );

    if (shouldTriggerFLIP) {
      this.prepForAnimation();
      this.runAnimation();


      // As a fallback to cover potential bugs with transitionend events still not triggering (despite our
      // efforts) we are going to force a cleanup after X ms.
      if (this.cleanupFallback) {

        // Refresh any previous timeouts...
        clearTimeout(this.cleanupFallback);

      }

      const { duration, delay, staggerDurationBy, staggerDelayBy } = this.props;
      const expectedToBeFinished = duration + delay +
        Math.max(oldChildrenKeys.length, nextChildrenKeys.length) * (staggerDurationBy + staggerDelayBy) +
        100;

      this.cleanupFallback = setTimeout(() => {
        const remainingTransitions = Object.values(this.transitionEndHandlerMap);
        if (remainingTransitions.length > 0) {
          // You did some really weird stuff for this to trigger...
          // We are going to do a manual cleanup for now until we can cover all the super edge cases...
          Object.values(this.transitionEndHandlerMap).forEach(({ callback }) => {
            callback();
          })
        }
      }, expectedToBeFinished)
    }

  }

  calculateNextSetOfChildren(nextChildren) {

     /*console.log("Old State...");
     console.log(JSON.stringify(this.state.children.map((child) => ({
     key: child.key,
     status: this.tracker.getStatus(child.key)
     }))));*/

    // We want to:
    //   - Mark all new children as `entering`
    //   - Pull in previous children that aren't in nextChildren, and mark them
    //     as `leaving`
    //   - Preserve the nextChildren list order, with leaving children in their
    //     appropriate places.
    //

    // We are going to track these in order to determine if items have shuffled...
    const nextChildrenKeysThatAlreadyExistInState = [];
    const stateChildrenKeysThatExistInNextChildren = [];

    // Start by marking new children as 'entering'
    const updatedChildren = nextChildren.map((nextChild) => {

      const childKey = nextChild.key;
      const child = this.findChildByKey(childKey);

      // If the item also exists in the previous state then we are going to save its key in the array...
      /*if (child){
       nextChildrenKeysThatAlreadyExistInState.push(childKey);
       }*/

      // If the child is new or already left in the previous state...
      if (!child || this.tracker.hasLeft(childKey)) {
        if (this.props.enterAnimation) {
          this.tracker.markAsQueuedToEnter(childKey);
        } else {
          this.tracker.markAsEnterWithoutAnimation(childKey);
        }
      }

      // If the child was leaving but not toggled...
      else if (this.tracker.isLeaving(childKey)) {
        if (this.props.enterAnimation) {
          this.tracker.markAsToggledToEntering(childKey);
        } else {
          this.tracker.markAsToggledToEnteringWithoutAnimation(childKey);
        }
      }

      return { ...nextChild };
    });

    // This is tricky. We want to keep the nextChildren's ordering, but with
    // any just-removed items maintaining their original position.
    // eg.
    //   this.state.children  = [ 1, 2, 3, 4 ]
    //   nextChildren         = [ 3, 1 ]
    //
    // In this example, we've removed the '2' & '4'
    // We want to end up with:  [ 2, 3, 1, 4 ]
    //
    // To accomplish that, we'll iterate through this.state.children. whenever
    // we find a match, we'll append our `leaving` flag to it, and insert it
    // into the nextChildren in its ORIGINAL position. Note that, as we keep
    // inserting old items into the new list, the "original" position will
    // keep incrementing.
    let numOfChildrenLeaving = 0;

     /*console.log("Before:");
     console.log(this.state.children.map((child) => child.key));

     console.log("New children order:");
     console.log(updatedChildren.map((child) => child.key));*/

    this.state.children.forEach((child, index) => {
      const childKey = child.key;
      const existsInNewChildren = nextChildren.find(({key}) => key === childKey);

      // If the item also exists in the new children then we are going to save its key in the array...
      if (existsInNewChildren) {
        stateChildrenKeysThatExistInNextChildren.push(childKey);
      }

      // If the child isn't leaving (or, if there is no leave animation),
      // we don't need to add it into the state children.
      //if (existsInNewChildren || !this.props.leaveAnimation) return;

      // If the item does not exist in the new children then we want them to prepare for leaving...
      if (!existsInNewChildren) {

        // If the item was entering but has now toggle to leave...
        if (this.tracker.isEntering(childKey) || this.tracker.shouldStartEntering(childKey)) {
          this.tracker.markAsToggledToLeaving(childKey);
        }

        else if (this.tracker.isIdle(childKey)) {
          this.tracker.markAsQueuedToLeave(childKey);
        }
      }

      if (this.tracker.isLeaving(childKey) ||
        this.tracker.hasLeft(childKey) ||
        this.tracker.shouldStartLeaving(childKey)) {

        const nextChild = { ...child };

        let nextChildIndex;

        // The fact that this should only use be used for isQueuedForLeaving items
        // was kind of found by trail and error.
        if (this.tracker.isQueuedForLeaving(childKey) || this.tracker.hasLeft(childKey)) {
          nextChildIndex = index + numOfChildrenLeaving;
        } else {
          nextChildIndex = index;
        }

        updatedChildren.splice(nextChildIndex, 0, nextChild);

        // The fact that this should only use be used for isQueuedForLeaving items
        // was kind of found by trail and error.
        if (this.tracker.isQueuedForLeaving(childKey) || this.tracker.hasLeft(childKey)) {
          numOfChildrenLeaving += 1;
        }
      }

    });


    // We now have the final order of updated children so we can get the keys in order for the final state...
    updatedChildren.forEach((child) => {

      // If the item also exists in the previous state then we are going to save its key in the array...
      if (stateChildrenKeysThatExistInNextChildren.indexOf(child.key) !== -1) {
        nextChildrenKeysThatAlreadyExistInState.push(child.key);
      }

    });


     /*console.log("After:");
     console.log(updatedChildren.map((child) => child.key));
     console.log(JSON.stringify(updatedChildren.map((child) => ({
     key: child.key,
     status: this.tracker.getStatus(child.key)
     }))));*/

    // If the arrays are not equal we have items that changed order aka shuffled...
    // This is important because we want to refresh transitions if this is the case.
    // We we don't then the transitionend callbacks are not fired because elements are moved (re-appended to
    // the dom, which interrupts transitions)
    this.childrenHaveShuffled = !arraysEqual(
      nextChildrenKeysThatAlreadyExistInState,
      stateChildrenKeysThatExistInNextChildren
    );

    /*console.log("Shuffled:");
    console.log(this.childrenHaveShuffled);*/
    return updatedChildren;
  }


  prepForAnimation() {
    // Our animation prep consists of:
    // - remove children that are leaving from the DOM flow, so that the new
    //   layout can be accurately calculated,
    // - update the placeholder container height, if needed, to ensure that
    //   the parent's height doesn't collapse.

    const {
      leaveAnimation,
      maintainContainerHeight,
      getPosition,
    } = this.props;

    // we need to make all leaving nodes "invisible" to the layout calculations
    // that will take place in the next step (this.runAnimation).
    if (leaveAnimation) {

      const leavingChildren = this.state.children.filter(child => (
        this.tracker.shouldStartLeaving(child)
      ));

      leavingChildren.forEach((leavingChild) => {
        const childData = this.childrenData[leavingChild.key];

        // We need to take the items out of the "flow" of the document, so that
        // its siblings can move to take its place.
        if (childData.boundingBox) {
          removeNodeFromDOMFlow(childData, this.props.verticalAlignment);
        }
      });

      if (maintainContainerHeight) {
        updateHeightPlaceholder({
          domNode: this.heightPlaceholderData.domNode,
          parentData: this.parentData,
          getPosition,
        });
      }
    }

    // For all children not in the middle of entering or leaving,
    // we need to reset the transition, so that the NEW shuffle starts from
    // the right place.
    this.state.children.forEach((child) => {
      const { domNode } = this.childrenData[child.key];

      // Ignore children that don't render DOM nodes (eg. by returning null)
      if (!domNode) {
        return;
      }

      if (this.tracker.isIdle(child) || this.tracker.shouldToggleToEnteringWithoutAnimation(child)) {

        let styles = {
          transition: ''
        };

        if (this.tracker.shouldToggleToEnteringWithoutAnimation(child)) {
          this.removeTransitionEndHandler(domNode, child.key);
          styles = {
            ...this.getUndoLeavingStyles(),
            transform: '',
            opacity: '',
            ...styles
          };
        }

        applyStylesToDOMNode({
          domNode,
          styles
        });
      }
    });
  }

  runAnimation() {
    const dynamicChildren = this.state.children.filter(
      this.doesChildNeedToBeAnimated
    );

    dynamicChildren.forEach((child, n) => {

      // Only add the child to childrenToAnimate if not already there...
      if (this.childrenToAnimate.indexOf(child.key) === -1)
        this.childrenToAnimate.push(child.key);

      this.animateChild(child, n);
    });

    if (this.props.onStartAll) {
      const [elements, domNodes] = this.formatChildrenForHooks();
      this.props.onStartAll(elements, domNodes);
    }

    // We can now safely mark all children that are entering without animation as idle...
    this.state.children.forEach((child) => {
      if (this.tracker.hasNoEnterAnimation(child)) {
        this.tracker.markAsIdle(child);
      }
    });
  }

  animateChild(child, index) {
    const { domNode } = this.childrenData[child.key];
    const hasToggled = this.tracker.hasToggled(child);

    // If a child has just toggled between entering and leaving so we can already remove
    // the existing one in favor of a new one...
    if (hasToggled) {
      this.removeTransitionEndHandler(domNode, child.key);
    }

    // Apply the relevant style for this DOM node
    // This is the offset from its actual DOM position.
    // eg. if an item has been re-rendered 20px lower, we want to apply a
    // style of 'transform: translate(-20px)', so that it appears to be where
    // it started.
    // In FLIP terminology, this is the 'Invert' stage.
    const computedStyles = this.computeInitialStyles(child);

    if (computedStyles) {
      applyStylesToDOMNode({
        domNode,
        styles: computedStyles,
      });
    }

    // We only have to add a new onStart handler if the child is actually fresh...
    // We don't have to run onStart for animations that toggled...
    if (this.tracker.isQueuedForEntering(child) || this.tracker.isQueuedForLeaving(child)) {
      // Start by invoking the onStart callback for this child.
      if (this.props.onStart)
        this.props.onStart(child, domNode);
    }


    // Next, animate the item from it's artificially-offset position to its
    // new, natural position.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        // NOTE, RE: the double-requestAnimationFrame:
        // Sadly, this is the most browser-compatible way to do this I've found.
        // Essentially we need to set the initial styles outside of any request
        // callbacks to avoid batching them. Then, a frame needs to pass with
        // the styles above rendered. Then, on the second frame, we can apply
        // our final styles to perform the animation.

        // Our first order of business is to "undo" the styles applied in the
        // previous frames, while also adding a `transition` property.
        // This way, the item will smoothly transition from its old position
        // to its new position.
        let styles = {
          transition: createTransitionString(index, this.props),
          transform: '',
          opacity: '',
        };

        // We are (re)applying the final state for entering animations...
        if ((this.tracker.shouldStartEntering(child) || this.tracker.isEntering(child)) && this.props.enterAnimation) {
          styles = {
            ...styles,
            ...this.props.enterAnimation.to,
          };

          this.tracker.markAsEntering(child);

        }

        // We are (re)applying the final state for leaving animations...
        else if ((this.tracker.shouldStartLeaving(child) || this.tracker.isLeaving(child)) && this.props.leaveAnimation) {
          styles = {
            ...styles,
            ...this.props.leaveAnimation.to,
          };

          this.tracker.markAsLeaving(child);
        }

        // In FLIP terminology, this is the 'Play' stage.
        applyStylesToDOMNode({ domNode, styles });
      });
    });

    this.bindTransitionEndHandler(child);
  }

  addTransitionEndHandler(domNode, childKey, callback) {

    // We are removing any existing listeners as we only allow a single handler per child...
    this.removeTransitionEndHandler(childKey);

    // Saves the transition in the map in order to remove it if required...
    this.transitionEndHandlerMap[childKey] = {
      domNode,
      callback
    };

    // Adds a transition end handler to a dom node...
    domNode.addEventListener(transitionEnd, callback);

  }

  removeTransitionEndHandler(childKey) {

    // Removes a transition end handler from a dom node and removes it from the transitionEndHandlerMap obj.
    if (this.transitionEndHandlerMap[childKey]) {
      const { domNode, callback } = this.transitionEndHandlerMap[childKey];
      domNode.removeEventListener(transitionEnd, callback);
      delete this.transitionEndHandlerMap[childKey];
    }
  }

  bindTransitionEndHandler(child) {
    const { enterAnimation, leaveAnimation } = this.props;
    const { domNode} = this.childrenData[child.key];

    // The onFinish callback needs to be bound to the transitionEnd event.
    // We also need to unbind it when the transition completes, so this ugly
    // inline function is required (we need it here so it closes over
    // dependent variables `child` and `domNode`)
    const transitionEndHandler = (ev = null) => {

      // If event is null then the transitionEndHandler was forced by a timeout...

      // In CSS/JS transitionend is called for each property that is animating.
      // There are however cases where the browser (f.e. Chrome) calls transitionend for the opacity property
      // a lot earlier than transform. To tackle this we are going to wait for the transform to finish
      // if any is defined.

      // By default we are going to wait for transform to finish (transform is used for moving elements)...
      let waitForTransformToFinish = true;

      // We are check the enter/leave transitions to confirm they have a transform property...
      if (this.tracker.isLeaving(child) && leaveAnimation) {
        waitForTransformToFinish = Object.keys(leaveAnimation.to).indexOf('transform') !== -1;
      } else if (this.tracker.isEntering(child) && enterAnimation) {
        waitForTransformToFinish = Object.keys(enterAnimation.to).indexOf('transform') !== -1;
      }

      if (!ev || ev.propertyName === "transform" || !waitForTransformToFinish) {
        // It's possible that this handler is fired not on our primary transition,
        // but on a nested transition (eg. a hover effect). Ignore these cases.
        if (ev && ev.target !== domNode) return;

        // Remove the 'transition' inline style we added. This is cleanup.
        domNode.style.transition = '';

        // Removing the transitionEndHandlerMap from the tracking object has it finished...
        this.removeTransitionEndHandler(child.key);

        // Check if the transition that ended was a leaving animation to decide if the child has left...
        const hasLeft = this.tracker.isLeaving(child);
        if (hasLeft) this.tracker.markAsLeft(child);

        const hasEntered = this.tracker.isEntering(child);
        if (hasEntered) this.tracker.markAsIdle(child);

        // Trigger any applicable onFinish/onFinishAll hooks
        this.triggerFinishHooks(child, domNode);

        if (hasLeft) {
          delete this.childrenData[child.key];
        }
      }

    };

    // Adding the transition handler...
    this.addTransitionEndHandler(domNode, child.key, transitionEndHandler);
  }

  triggerFinishHooks(child, domNode) {
    if (this.props.onFinish) this.props.onFinish(child, domNode);

    //console.log(Object.keys(this.transitionEndHandlerMap).length);

    // We check if all transitionEndHandlers have finished...
    if (Object.keys(this.transitionEndHandlerMap).length === 0) {

      // Remove any items from the DOM that have left...
      const nextChildren = this.state.children
        .filter(({ key }) => !this.tracker.hasLeft(key))
        .map(item => ({
          ...item
        }));

      this.tracker.clearChildrenThatLeft();
      this.transitionEndHandlerMap = {};

      this.setState({ children: nextChildren }, () => {
        if (typeof this.props.onFinishAll === 'function') {
          const [elements, domNodes] = this.formatChildrenForHooks();

          this.props.onFinishAll(elements, domNodes);
        }

        // Reset our variables for the next iteration
        this.childrenToAnimate = [];
      });

      // If the placeholder was holding the container open while elements were
      // leaving, we we can now set its height to zero.
      if (this.heightPlaceholderData.domNode !== null) {
        this.heightPlaceholderData.domNode.style.height = 0;
      }
    }
  }

  formatChildrenForHooks() {
    const elements = [];
    const domNodes = [];

    this.childrenToAnimate.forEach((childKey) => {
      // If this was an exit animation, the child may no longer exist.
      // If so, skip it.
      const element = this.findChildByKey(childKey);

      if (!element) {
        return;
      }

      elements.push(element);
      domNodes.push(this.childrenData[childKey].domNode);
    });

    return [elements, domNodes];
  }

  updateBoundingBoxCaches() {
    // This is the ONLY place that parentData and childrenData's
    // bounding boxes are updated. They will be calculated at other times
    // to be compared to this value, but it's important that the cache is
    // updated once per update.
    this.parentData.boundingBox = this.props.getPosition(
      this.parentData.domNode
    );

    this.state.children.forEach((child) => {
      // It is possible that a child does not have a `key` property;
      // Ignore these children, they don't need to be moved.
      if (!child.key) {
        return;
      }

      const childData = this.childrenData[child.key];

      // In very rare circumstances, for reasons unknown, the ref is never
      // populated for certain children. In this case, avoid doing this update.
      // see: https://github.com/joshwcomeau/react-flip-move/pull/91
      if (!childData) {
        return;
      }

      // If the child element returns null, we need to avoid trying to
      // account for it
      if (!childData.domNode) {
        return;
      }

      childData.boundingBox = getRelativeBoundingBox({
        childData,
        parentData: this.parentData,
        getPosition: this.props.getPosition,
      });
    });
  }

  // The style properties necessary to undo a leaving item...
  getUndoLeavingStyles() {
    return {
      position: '',
      top: '',
      left: '',
      right: '',
      bottom: '',
    };
  }

  transformMatrixStringToArray = (matrix) => {
    const matrixPattern = /^\w*\((((\d+)|(\d*\.\d+)),\s*)*((\d+)|(\d*\.\d+))\)/i;
    let matrixValue = [];
    if (matrixPattern.test(matrix)) { // When it satisfy the pattern.
      const matrixCopy = matrix.replace(/^\w*\(/, '').replace(')', '');
      matrixValue = matrixCopy.split(/\s*,\s*/);
    }

    return matrixValue;
  };

  isEligibleForTransitionRefresh(child) {

    // We want to only refresh an entering transition if we know that items were shuffled during the last
    // render. Leaving animations we always want to refresh as they can otherwise prevent a
    // transitionend not being called (for an unknown reason).

    const isEntering = this.tracker.isEntering(child);
    const isLeaving = this.tracker.isLeaving(child);

    return ((isLeaving || isEntering) && this.childrenHaveShuffled) &&
      this.styleBeforeRender[child.key];
  }

  computeInitialStyles(child) {

    // Check whether wa want to re-attach / restart
    if (this.isEligibleForTransitionRefresh(child)) {

      // @todo We are currently not reducing the transition length in order to take into account that
      // the transition was already ongoing. This will result in transitions having their duration
      // reset whenever they are to be refreshed by this code.

      // Check if we are refreshing an entering transition...
      const isEntering = this.tracker.isEntering(child);

      // Get the saved transform and opacity values from before the recent update...
      let { transform, opacity } = this.styleBeforeRender[child.key];

      if (isEntering) {

        // Get the dom node of the child we are going to modify...
        const { domNode } = this.childrenData[child.key];

        // We are updating the dom with the current matrix in order to successfully calculate the delta
        // in the next step. This removes any ongoing translate values of moving nodes while entering...
        applyStylesToDOMNode({
          domNode,
          styles: {
            transform: transform,
            transition: ''
          },
        });

        // We are calculating the delta position to find out where the item has moved to.
        const [dX, dY] = getPositionDelta({
          childData: this.childrenData[child.key],
          parentData: this.parentData,
          getPosition: this.props.getPosition,
        });

        // We are combining the delta as a translate() together with the current transform value...
        // @todo For some odd reason the enter transition does not have the same problem as the leave
        // transition and can actually use the a matrix() to continue its animation of scale()...
        transform = `translate(${dX}px, ${dY}px)` + (transform !== "none" ? (" " + transform) : "");

        // We are going to apply immediately apply the styles because we want the transition to continue
        // from the current location.
        return {
          opacity,
          transition: '',
          transform
        };

      } else {

        // We cannot set transform to the current matrix as matrix() does not seem to transition to scale()...
        // @todo We are currently only adding losely adding a scale property and we expect the first value
        // of the matrix to be the scale() whereas a transition might actually need a different property like
        // scaleX, scaleY or contain a 3dmatrix.
        return {
          opacity,
          transition: '',
          transform: transform !== 'none' ? `scale(${this.transformMatrixStringToArray(transform)[0]})` : 'none'
        }

      }
    }

    const shouldStartEntering = this.tracker.shouldStartEntering(child);
    const shouldStartLeaving = this.tracker.shouldStartLeaving(child);
    const isQueuedToEnter = this.tracker.isQueuedForEntering(child);
    const isQueuedForLeaving = this.tracker.isQueuedForLeaving(child);


    // @todo Not sure if this is still required as we have multiple 'withoutAnimation' status...
    const enterOrLeaveWithoutAnimation = (
      (isQueuedToEnter && !this.props.enterAnimation) ||
      (isQueuedForLeaving && !this.props.leaveAnimation)
    );

    if (enterOrLeaveWithoutAnimation) {
      return {};
    }

    if (shouldStartEntering) {

      // If this child was in the middle of leaving, it still has its
      // absolute positioning styles applied. We need to undo those.
      const styles = this.getUndoLeavingStyles();


      return isQueuedToEnter ?

        // We are starting a fresh animation as the item did not just toggle...
        {
          ...styles,
          ...this.props.enterAnimation.from,
        } :

        // The item toggled so we do not need the base styles of the animation...
        styles;

    }

    else if (shouldStartLeaving) {
      return isQueuedForLeaving ?

        // The item was idle before so we want to set the initial styles...
        this.props.leaveAnimation.from :

        // The item was entering before so we don't need se initial styles...
        null;
    }

    // Items that are idle, or are entering (when no shuffling took place) will have
    // a move transtion applied...
    if (this.tracker.isIdle(child) || this.tracker.isEntering(child)) {

      const [dX, dY] = getPositionDelta({
        childData: this.childrenData[child.key],
        parentData: this.parentData,
        getPosition: this.props.getPosition,
      });

      return {
        transform: `translate(${dX}px, ${dY}px)`,
      };
    }
  }

  isAnimationDisabled(props) {
    // If the component is explicitly passed a `disableAllAnimations` flag,
    // we can skip this whole process. Similarly, if all of the numbers have
    // been set to 0, there is no point in trying to animate; doing so would
    // only cause a flicker (and the intent is probably to disable animations)
    // We can also skip this rigamarole if there's no browser support for it.
    return (
      noBrowserSupport ||
      props.disableAllAnimations ||
      (
        props.duration === 0 &&
        props.delay === 0 &&
        props.staggerDurationBy === 0 &&
        props.staggerDelayBy === 0
      )
    );
  }

  doesChildNeedToBeAnimated(child) {
    // If the child doesn't have a key, it's an immovable child (one that we
    // do not want to do FLIP stuff to.)
    if (!child.key) {
      return false;
    }

    const childData = this.childrenData[child.key];

    if (!childData.domNode) {
      return false;
    }

    // If the child is eligible for a transition refresh than we want to re(animate)...
    if (this.isEligibleForTransitionRefresh(child)) {
      return true;
    }

    // Entering children that don't have an animation will now be marked as idle and do not have to animate...
    if (this.tracker.shouldEnterWithoutAnimation(child) || this.tracker.shouldToggleToEnteringWithoutAnimation(child)) {
      return false;
    }

    // If the child should start entering or leaving; whether there is an animation has already been checked...
    if (this.tracker.shouldStartEntering(child) || this.tracker.shouldStartLeaving(child)) {
      return true;
    }

    if (this.tracker.isIdle(child) || this.tracker.isEntering(child)) {

      const { getPosition } = this.props;

      // Children that are idle, or are entering (when no shuffling took place)
      // will transition if they actually moved

      const [dX, dY] = getPositionDelta({
        childData,
        parentData: this.parentData,
        getPosition,
      });

      return dX !== 0 || dY !== 0;
    }

    return false;
  }

  // A method for debugging...
  debugComputedStyleForChildByKey(key) {
    const {domNode} = this.childrenData[key];
    const {transform, transition, opacity, position, top, left} = getComputedStyle(domNode);
  }

  findChildByKey(key) {
    return this.state.children.find(child => child.key === key);
  }

  createHeightPlaceholder() {
    const { typeName } = this.props;

    // If requested, create an invisible element at the end of the list.
    // Its height will be modified to prevent the container from collapsing
    // prematurely.
    const isContainerAList = typeName === 'ul' || typeName === 'ol';
    const placeholderType = isContainerAList ? 'li' : 'div';

    return React.createElement(
      placeholderType,
      {
        key: 'height-placeholder',
        ref: (domNode) => {
          this.heightPlaceholderData.domNode = domNode;
        },
        style: {visibility: 'hidden', height: 0},
      }
    );
  }

  childrenWithRefs() {
    // We need to clone the provided children, capturing a reference to the
    // underlying DOM node. Flip Move needs to use the React escape hatches to
    // be able to do its calculations.
    return this.state.children.map(child => (
      React.cloneElement(child, {
        ref: (element) => {
          // Stateless Functional Components are not supported by FlipMove,
          // because they don't have instances.
          if (!element) {
            return;
          }

          const domNode = getNativeNode(element);

          // If this is the first render, we need to create the data entry
          if (!this.childrenData[child.key]) {
            this.childrenData[child.key] = {};
          }

          this.childrenData[child.key].domNode = domNode;
        },
      })
    ));
  }

  render() {
    const {
      typeName,
      delegated,
      leaveAnimation,
      maintainContainerHeight,
    } = this.props;

    const props = {
      ...delegated,
      ref: (node) => { this.parentData.domNode = node; },
    };

    const children = this.childrenWithRefs();
    if (leaveAnimation && maintainContainerHeight) {
      children.push(this.createHeightPlaceholder());
    }

    return React.createElement(
      typeName,
      props,
      children
    );
  }
}

export default propConverter(FlipMove);