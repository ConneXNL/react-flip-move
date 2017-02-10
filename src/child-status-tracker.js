// A child always has only a single status.
// Some statuses do not live during the entire render cycle but are just a temporary status before actual
// transitions have started.

export const ChildStatusType = {

  // Items that are idle are not entering or leaving... (they might be moving though!)
  // Whenever entering/leaving finish the item will get this status.
  // Items that were already there before the first render will start as idle.
  IDLE: 'IDLE',

  // The child is getting ready to have its entering transition being added...
  QUEUED_TO_ENTER: 'QUEUED_TO_ENTER',

  // The child is currently in the middle of an entering transition...
  ENTERING: 'ENTERING',

  // The child is about to enter without animation...
  ENTER_WITHOUT_ANIMATION: 'ENTER_WITHOUT_ANIMATION',

  // The child is about to (re)enter without animation while it was still leaving...
  TOGGLED_TO_ENTERING_WITHOUT_ANIMATION: 'TOGGLED_TO_ENTERING_WITHOUT_ANIMATION',

  // The child is now scheduled to (re)enter while it was still leaving...
  TOGGLED_TO_ENTERING: 'TOGGLED_TO_ENTERING',

  // The child is getting ready to have its leaving transition being added...
  QUEUED_TO_LEAVE: 'QUEUED_TO_LEAVE',

  // The child is currently in the middle of a leaving transition...
  LEAVING: 'LEAVING',

  // The child is now scheduled to leave while it was still entering...
  TOGGLED_TO_LEAVING: 'TOGGLED_TO_LEAVING',

  // The item has finished its leaving transition and is waiting for the cleanup...
  LEFT: 'LEFT'

};


// The tracker currently has methods for checking and setting all states.
// If preferred one could also use getStatus/setStatus in combination with the above ChildStatusType.
export class ChildStatusTracker {

  constructor() {
    this.children = {};
  }

  resolveChildKey(childOrKey) {
    if (typeof childOrKey === "string" || typeof childOrKey === "number") {
      return childOrKey;
    } else if (childOrKey.key) {
      return childOrKey.key;
    } else {
      console.error("Cannot resolve key from child, no key can be found...");
    }
  }

  clear() {
    this.children = {};
  }

  clearChildrenThatLeft() {
    const newChildren = {};

    Object.keys(this.children).forEach((key) => {
      const value = this.children[key];
      if (value !== ChildStatusType.LEFT) {
        newChildren[key] = value;
      }
    });

    this.children = newChildren;

    // Uncomment the next line to see log all changes the children status...
    // console.log(JSON.stringify(this.children));
  }

  isNotEnteringOrLeaving(childOrKey) {
    const status = this.getStatus(childOrKey);
    return !this.isEnteringStatus(status) && !this.isLeavingStatus(status);
  }

  areAllIdleOrHaveLeft() {
    return !(Object.values(this.children).filter((status) =>
      status !== ChildStatusType.IDLE && status !== ChildStatusType.LEFT
    ).length > 0);
  }

  isEntering(childOrKey) {
    const status = this.getStatus(childOrKey);
    return status === ChildStatusType.ENTERING;
  }

  isLeaving(childOrKey) {
    const status = this.getStatus(childOrKey);
    return status === ChildStatusType.LEAVING;
  }

  isQueuedForEntering(childOrKey) {
    return this.getStatus(childOrKey) === ChildStatusType.QUEUED_TO_ENTER;
  }

  isQueuedForLeaving(childOrKey) {
    return this.getStatus(childOrKey) === ChildStatusType.QUEUED_TO_LEAVE;
  }

  shouldEnterWithoutAnimation(childOrKey) {
    return this.getStatus(childOrKey) === ChildStatusType.ENTER_WITHOUT_ANIMATION;
  }

  shouldToggleToEnteringWithoutAnimation(childOrKey) {
    return this.getStatus(childOrKey) === ChildStatusType.TOGGLED_TO_ENTERING_WITHOUT_ANIMATION;
  }

  hasNoEnterAnimation(childOrKey) {
    return this.shouldToggleToEnteringWithoutAnimation(childOrKey) || this.shouldEnterWithoutAnimation(childOrKey);
  }

  markAsLeft(childOrKey) {
    return this.setStatus(childOrKey, ChildStatusType.LEFT);
  }

  markAsQueuedToEnter(childOrKey) {
    return this.setStatus(childOrKey, ChildStatusType.QUEUED_TO_ENTER);
  }

  markAsEnterWithoutAnimation(childOrKey) {
    return this.setStatus(childOrKey, ChildStatusType.ENTER_WITHOUT_ANIMATION);
  }

  markAsToggledToEnteringWithoutAnimation(childOrKey) {
    return this.setStatus(childOrKey, ChildStatusType.TOGGLED_TO_ENTERING_WITHOUT_ANIMATION);
  }

  markAsToggledToEntering(childOrKey) {
    return this.setStatus(childOrKey, ChildStatusType.TOGGLED_TO_ENTERING);
  }

  markAsQueuedToLeave(childOrKey) {
    return this.setStatus(childOrKey, ChildStatusType.QUEUED_TO_LEAVE);
  }

  markAsToggledToLeaving(childOrKey) {
    return this.setStatus(childOrKey, ChildStatusType.TOGGLED_TO_LEAVING);
  }

  markAsIdle(childOrKey) {
    return this.setStatus(childOrKey, ChildStatusType.IDLE);
  }

  hasLeft(childOrKey) {
    return this.getStatus(childOrKey) === ChildStatusType.LEFT;
  }

  hasToggled(childOrKey) {
    const childKey = this.resolveChildKey(childOrKey);
    return this.children[childKey] &&
      (this.children[childKey] === ChildStatusType.TOGGLED_TO_ENTERING ||
      this.children[childKey] === ChildStatusType.TOGGLED_TO_LEAVING);
  }

  getStatus(childOrKey) {
    const childKey = this.resolveChildKey(childOrKey);
    if (this.children[childKey]) {
      return this.children[childKey];
    }
    return null;
  }


  setStatus(childOrKey, newStatus) {
    const childKey = this.resolveChildKey(childOrKey);
    this.children[childKey] = newStatus;

    // Uncomment the next line to see log all changes the children status...
    // console.log(JSON.stringify(this.children));
  }

  isLeavingStatus(status) {
    return (
      status === ChildStatusType.LEAVING ||
      status === ChildStatusType.QUEUED_TO_LEAVE ||
      status === ChildStatusType.TOGGLED_TO_LEAVING
    );
  }

  isEnteringStatus(status) {
    return (
      status === ChildStatusType.ENTERING ||
      status === ChildStatusType.QUEUED_TO_ENTER ||
      status === ChildStatusType.TOGGLED_TO_ENTERING
    );
  }

  isIdle(childOrKey) {
    return this.getStatus(childOrKey) === ChildStatusType.IDLE;
  }

  isIdleStatus(status) {
    return status === ChildStatusType.IDLE;
  }

  shouldStartEntering(childOrKey) {
    const status = this.getStatus(childOrKey);
    return status === ChildStatusType.TOGGLED_TO_ENTERING || status === ChildStatusType.QUEUED_TO_ENTER;
  }

  shouldStartLeaving(childOrKey) {
    const status = this.getStatus(childOrKey);
    return status === ChildStatusType.TOGGLED_TO_LEAVING || status === ChildStatusType.QUEUED_TO_LEAVE;
  }

  markAsEntering(childOrKey) {
    this.setStatus(childOrKey, ChildStatusType.ENTERING)
  }

  markAsLeaving(childOrKey) {
    this.setStatus(childOrKey, ChildStatusType.LEAVING)
  }

}
