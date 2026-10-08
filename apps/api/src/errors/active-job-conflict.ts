export class ActiveJobConflict extends Error {
  constructor() {
    super('A queued or running job already exists.');
    this.name = 'ActiveJobConflict';
  }
}
