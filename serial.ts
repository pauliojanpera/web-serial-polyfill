/*
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in
 * compliance with the License. You may obtain a copy of
 * the License at
 *
 *    https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in
 * writing, software distributed under the License is
 * distributed on an "AS IS" BASIS, WITHOUT WARRANTIES
 * OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing
 * permissions and limitations under the License.
 */
'use strict';

export enum SerialPolyfillProtocol {
  // eslint-disable-next-line no-unused-vars
  UsbCdcAcm,
  // eslint-disable-next-line no-unused-vars
  FTDI,
}

export interface SerialPolyfillOptions {
  protocol?: SerialPolyfillProtocol;
  usbDeviceClass?: number;
  usbControlInterfaceClass?: number;
  usbTransferInterfaceClass?: number;
  defaultBufferSize?: number;
}

const kDefaultPolyfillOptions: SerialPolyfillOptions[] = [{
  protocol: SerialPolyfillProtocol.UsbCdcAcm,
  usbDeviceClass: 2,
  usbControlInterfaceClass: 2,
  usbTransferInterfaceClass: 10,
  defaultBufferSize: 255,
}, {
  protocol: SerialPolyfillProtocol.FTDI,
  usbDeviceClass: 0,
  usbControlInterfaceClass: 255,
  usbTransferInterfaceClass: 255,
  defaultBufferSize: 62,
}];

const polyfillOptionsWithDefaults = (
    polyfillOptions:SerialPolyfillOptions|undefined
) => ({
  ...kDefaultPolyfillOptions[polyfillOptions&&polyfillOptions?.protocol||0],
  ...polyfillOptions,
});
/**
 * Utility function to get the interface implementing a desired class.
 * @param {USBDevice} device The USB device.
 * @param {number} classCode The desired interface class.
 * @return {USBInterface} The first interface found that implements the desired
 * class.
 * @throws TypeError if no interface is found.
 */
function findInterface(device: USBDevice, classCode: number): USBInterface {
  const configuration = device.configurations[0];
  for (const iface of configuration.interfaces) {
    const alternate = iface.alternates[0];
    if (alternate.interfaceClass === classCode) {
      return iface;
    }
  }
  throw new TypeError(`Unable to find interface with class ${classCode}.`);
}

/**
 * Utility function to get an endpoint with a particular direction.
 * @param {USBInterface} iface The interface to search.
 * @param {USBDirection} direction The desired transfer direction.
 * @return {USBEndpoint} The first endpoint with the desired transfer direction.
 * @throws TypeError if no endpoint is found.
 */
function findEndpoint(iface: USBInterface, direction: USBDirection):
    USBEndpoint {
  const alternate = iface.alternates[0];
  for (const endpoint of alternate.endpoints) {
    if (endpoint.direction === direction) {
      return endpoint;
    }
  }
  throw new TypeError(`Interface ${iface.interfaceNumber} does not have an ` +
                      `${direction} endpoint.`);
}

interface USBSerialProtocol {
  isValidBaudRate(baudRate: number): boolean;
  isValidDataBits(dataBits: number | undefined): boolean;
  isValidStopBits(stopBits: number | undefined): boolean;
  isValidParity(parity: ParityType | undefined): boolean;

  setLineCoding(): Promise<void>;
  setSignals(signals: SerialOutputSignals): Promise<void>;

  /**
   * Implementation of the underlying source API[1] which reads data from a USB
   * endpoint. This can be used to construct a ReadableStream.
   *
   * [1]: https://streams.spec.whatwg.org/#underlying-source-api
   */
  createReadable(bufferSize: number) : ReadableStream<Uint8Array>;
  createWritable(bufferSize: number) : WritableStream<Uint8Array>;
}

/** a class used to control serial devices over WebUSB */
export class SerialPort {
  private polyfillOptions_: SerialPolyfillOptions;
  private device_: USBDevice;
  private controlInterface_: USBInterface;
  private transferInterface_: USBInterface;
  private inEndpoint_: USBEndpoint;
  private outEndpoint_: USBEndpoint;

  private serialOptions_: SerialOptions;
  private readable_: ReadableStream<Uint8Array> | null;
  private writable_: WritableStream<Uint8Array> | null;
  private outputSignals_: SerialOutputSignals;

  private protocol_: USBSerialProtocol;

  // eslint-disable-next-line require-jsdoc
  private get UsbCdcAcmProtocol() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const usbSerialPort_: SerialPort = this;

    const kSetLineCoding = 0x20;
    const kSetControlLineState = 0x22;
    const kSendBreak = 0x23;

    const kDefaultDataBits = 8;
    const kDefaultParity = 'none';
    const kDefaultStopBits = 1;

    const kAcceptableDataBits = [16, 8, 7, 6, 5];
    const kAcceptableStopBits = [1, 2];
    const kAcceptableParity = ['none', 'even', 'odd'];

    const kParityIndexMapping: ParityType[] =
        ['none', 'odd', 'even'];
    const kStopBitsIndexMapping = [1, 1.5, 2];
    return class implements USBSerialProtocol {
      /**
       * @param {number} bufferSize
       * @return {UnderlyingSource<Uint8Array>}
       */
      createReadable(bufferSize: number): ReadableStream<Uint8Array> {
        return new ReadableStream<Uint8Array>({
          /**
            * Reads a chunk of data from the device.
            *
            * @param {ReadableStreamDefaultController} controller
            */
          async pull(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
            const packetSize = usbSerialPort_.inEndpoint_.packetSize;
            const chunkSize = controller.desiredSize ?
              Math.ceil(controller.desiredSize / packetSize) * packetSize :
              packetSize;

            try {
              const result = await usbSerialPort_.device_.transferIn(
                  usbSerialPort_.inEndpoint_.endpointNumber, chunkSize);
              if (result.status !== 'ok') {
                throw new Error(`USB error: ${result.status}`);
              }
              controller.enqueue(result.data?.buffer ?
                new Uint8Array(
                    result.data.buffer,
                    result.data.byteOffset,
                    result.data.byteLength
                ) : new Uint8Array(0));
            } catch (error) {
              controller.error(error.toString());
              usbSerialPort_.readable_ = null;
            }
          },
        },
        new ByteLengthQueuingStrategy({ highWaterMark: bufferSize }));
      }

      /**
       * @param {number} bufferSize
       * @return {WritableStream<Uint8Array>}
       */
      createWritable(bufferSize: number) : WritableStream<Uint8Array> {
        return new WritableStream<Uint8Array>({
            /**
             * Writes a chunk to the device.
             *
             * @param {Uint8Array} chunk
             * @param {WritableStreamDefaultController} controller
             */
            async write(
              chunk: Uint8Array,
              controller: WritableStreamDefaultController): Promise<void> {
            try {
              const result = await this.device_.transferOut(
                usbSerialPort_.outEndpoint_.endpointNumber, chunk);
              if (result.status !== 'ok') {
                throw new Error(`USB transferOut error: ${result.status}`);
              }
            } catch (error) {
              controller.error(error.toString());
              usbSerialPort_.writable_ = null;
            }
          },
        },
        new ByteLengthQueuingStrategy({ highWaterMark: bufferSize }));
      }
      /**
       * Checks the baud rate for validity
       * @param {number} baudRate the baud rate to check
       * @return {boolean} A boolean that reflects whether the baud rate is valid
       */
      isValidBaudRate(baudRate: number): boolean {
        return baudRate % 1 === 0;
      }

      /**
       * Checks the data bits for validity
       * @param {number} dataBits the data bits to check
       * @return {boolean} A boolean that reflects whether the data bits setting is
       * valid
       */
      isValidDataBits(dataBits: number | undefined): boolean {
        if (typeof dataBits === 'undefined') {
          return true;
        }
        return kAcceptableDataBits.includes(dataBits);
      }

      /**
       * Checks the stop bits for validity
       * @param {number} stopBits the stop bits to check
       * @return {boolean} A boolean that reflects whether the stop bits setting is
       * valid
       */
      isValidStopBits(stopBits: number | undefined): boolean {
        if (typeof stopBits === 'undefined') {
          return true;
        }
        return kAcceptableStopBits.includes(stopBits);
      }

      /**
       * Checks the parity for validity
       * @param {string} parity the parity to check
       * @return {boolean} A boolean that reflects whether the parity is valid
       */
      isValidParity(parity: ParityType | undefined): boolean {
        if (typeof parity === 'undefined') {
          return true;
        }
        return kAcceptableParity.includes(parity);
      }

      /**
       * sends the options alog the control interface to set them on the device
       * @return {Promise} a promise that will resolve when the options are set
       */
      async setLineCoding(): Promise<void> {
        // Ref: USB CDC specification version 1.1 §6.2.12.
        const buffer = new ArrayBuffer(7);
        const view = new DataView(buffer);
        view.setUint32(0, usbSerialPort_.serialOptions_.baudRate, true);
        view.setUint8(
            4, kStopBitsIndexMapping.indexOf(
                usbSerialPort_.serialOptions_.stopBits ?? kDefaultStopBits));
        view.setUint8(
            5, kParityIndexMapping.indexOf(
                usbSerialPort_.serialOptions_.parity ?? kDefaultParity));
        view.setUint8(6, usbSerialPort_.serialOptions_.dataBits ?? kDefaultDataBits);

        const result = await usbSerialPort_.device_.controlTransferOut({
          'requestType': 'class',
          'recipient': 'interface',
          'request': kSetLineCoding,
          'value': 0x00,
          'index': usbSerialPort_.controlInterface_.interfaceNumber,
        }, buffer);
        if (result.status !== 'ok') {
          throw new DOMException('NetworkError', 'Failed to set line coding.');
        }
      }

      /**
       * Sets control signal state for the port.
       * @param {SerialOutputSignals} signals The signals to enable or disable.
       * @return {Promise<void>} a promise that is resolved when the signal state
       * has been changed.
       */
      public async setSignals(signals: SerialOutputSignals): Promise<void> {
        usbSerialPort_.outputSignals_ = {...usbSerialPort_.outputSignals_, ...signals};
        if (signals.dataTerminalReady !== undefined ||
            signals.requestToSend !== undefined) {
          // The Set_Control_Line_State command expects a bitmap containing the
          // values of all output signals that should be enabled or disabled.
          //
          // Ref: USB CDC specification version 1.1 §6.2.14.
          const value =
            (usbSerialPort_.outputSignals_.dataTerminalReady ? 1 << 0 : 0) |
            (usbSerialPort_.outputSignals_.requestToSend ? 1 << 1 : 0);

          await usbSerialPort_.device_.controlTransferOut({
            'requestType': 'class',
            'recipient': 'interface',
            'request': kSetControlLineState,
            'value': value,
            'index': usbSerialPort_.controlInterface_.interfaceNumber,
          });
        }

        if (signals.break !== undefined) {
          // The SendBreak command expects to be given a duration for how long
          // the break signal should be asserted. Passing 0xFFFF enables the
          // signal until 0x0000 is send.
          //
          // Ref: USB CDC specification version 1.1 §6.2.15.
          const value = usbSerialPort_.outputSignals_.break ? 0xFFFF : 0x0000;

          await usbSerialPort_.device_.controlTransferOut({
            'requestType': 'class',
            'recipient': 'interface',
            'request': kSendBreak,
            'value': value,
            'index': usbSerialPort_.controlInterface_.interfaceNumber,
          });
        }
      }
    };
  }

  // eslint-disable-next-line require-jsdoc
  private get UsbFtdiProtocol() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const usbSerialPort_: SerialPort = this;

    const kDefaultDataBits = 8;
    const kDefaultParity = 'none';
    const kDefaultStopBits = 1;

    interface Dictionary<T> {
      [Key: string]: T;
    }
    const kDataBitsMapping : Dictionary<number> = {
      7: 7,
      8: 8,
    };
    const kParityMapping : Dictionary<number> = {
      none: 0x000,
      odd: 0x100,
      even: 0x200,
      // mark: 0x300,
      // space: 0x400,
    };
    const kStopBitsMapping : Dictionary<number> = {
      1: 0x0000,
      2: 0x2000,
    };

    const FTDI_SIO_MODEM_CTRL = 0x01; /* Set the modem control register */
    const FTDI_SIO_SET_BAUD_RATE = 0x03; /* Set baud rate */
    const FTDI_SIO_SET_DATA = 0x04; /* Set the data characteristics of the port */
    const FTDI_SIO_SET_LATENCY_TIMER = 0x09; /* Set the latency timer */

    return class implements USBSerialProtocol {
      /**
       * @param {number} bufferSize
       * @return {UnderlyingSource<Uint8Array>}
       */
       createReadable(bufferSize: number): ReadableStream<Uint8Array> {
          return new ReadableStream<Uint8Array>({
          /**
            * Reads a chunk of data from the device.
            *
            * @param {ReadableStreamDefaultController} controller
            */
          async pull(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
            const packetSize = usbSerialPort_.inEndpoint_.packetSize;
            const chunkSize = controller.desiredSize ?
              Math.ceil(controller.desiredSize+2 / packetSize) * packetSize :
              packetSize;

            try {
              const result = await usbSerialPort_.device_.transferIn(
                  usbSerialPort_.inEndpoint_.endpointNumber, chunkSize);
              if (result.status !== 'ok') {
                throw new Error(`USB error: ${result.status}`);
              }
              // Discard the FTDI_STATUS_Bn_MASK bytes.
              controller.enqueue(result.data?.buffer &&
                result.data.byteLength>2 ?
                new Uint8Array(
                    result.data.buffer,
                    result.data.byteOffset+2,
                    result.data.byteLength-2
                ) : new Uint8Array(0));
            } catch (error) {
              controller.error(error.toString());
              usbSerialPort_.readable_ = null;
            }
          },
        }, {
          highWaterMark: bufferSize,
          size: (chunk:Uint8Array) => Math.max(chunk.byteLength-2, 0),
        });
      }

      /**
       * @param {number} bufferSize
       * @return {WritableStream<Uint8Array>}
       */
      createWritable(bufferSize: number) : WritableStream<Uint8Array> {
        return new WritableStream<Uint8Array>({
            /**
             * Writes a chunk to the device.
             *
             * @param {Uint8Array} chunk
             * @param {WritableStreamDefaultController} controller
             */
            async write(
              chunk: Uint8Array,
              controller: WritableStreamDefaultController): Promise<void> {
            try {
              const result = await this.device_.transferOut(
                usbSerialPort_.outEndpoint_.endpointNumber, chunk);
              if (result.status !== 'ok') {
                throw new Error(`USB transferOut error: ${result.status}`);
              }
            } catch (error) {
              controller.error(error.toString());
              usbSerialPort_.writable_ = null;
            }
          },
        }, {
          highWaterMark: bufferSize,
          size: (chunk:Uint8Array) => Math.max(chunk.byteLength+2, 0),
        });
      }
      /**
       * Checks the baud rate for validity
       * @param {number} baudRate the baud rate to check
       * @return {boolean} A boolean that reflects whether the baud rate is valid
       */
      isValidBaudRate(baudRate: number): boolean {
        return baudRate % 1 === 0;
      }

      /**
       * Checks the data bits for validity
       * @param {number} dataBits the data bits to check
       * @return {boolean} A boolean that reflects whether the data bits setting is
       * valid
       */
      isValidDataBits(dataBits: number | undefined): boolean {
        if (typeof dataBits === 'undefined') {
          return true;
        }
        return dataBits in kDataBitsMapping;
      }

      /**
       * Checks the stop bits for validity
       * @param {number} stopBits the stop bits to check
       * @return {boolean} A boolean that reflects whether the stop bits setting is
       * valid
       */
      isValidStopBits(stopBits: number | undefined): boolean {
        if (typeof stopBits === 'undefined') {
          return true;
        }
        return stopBits in kStopBitsMapping;
      }

      /**
       * Checks the parity for validity
       * @param {string} parity the parity to check
       * @return {boolean} A boolean that reflects whether the parity is valid
       */
      isValidParity(parity: ParityType | undefined): boolean {
        if (typeof parity === 'undefined') {
          return true;
        }
        return parity in kParityMapping;
      }

      /**
       * Sets the number of data, parity and stop bits AND the break status.
       */
      async setDataCharacteristics(): Promise<void> {
        if ((await usbSerialPort_.device_.controlTransferOut({
          requestType: 'vendor',
          recipient: 'device',
          request: FTDI_SIO_SET_DATA,
          value: kDataBitsMapping[
              usbSerialPort_.serialOptions_.dataBits ?? kDefaultDataBits
          ]| kParityMapping[
              usbSerialPort_.serialOptions_.parity ?? kDefaultParity
          ]| kStopBitsMapping[
              usbSerialPort_.serialOptions_.stopBits ?? kDefaultStopBits
          ]| (usbSerialPort_.outputSignals_.break ? 0x4000 : 0),
          index: 0,
        })).status !== 'ok') {
          throw new DOMException(
              'NetworkError', 'Failed to set data characteristics.'
          );
        }
      }

      /**
       * Sends the options along the control interface to set them on the device
       * @return {Promise} a promise that will resolve when the options are set
       */
      async setLineCoding(): Promise<void> {
        const baudBase = 48000000;
        const getDivisor = (baud:number) => {
          let divisor = ((baudBase + baud) / (2 * baud))|0;
          divisor = (divisor >> 3) |
              ([0, 3, 2, 4, 1, 5, 6, 7][divisor & 0x7] << 14);
          switch (divisor) {
            case 1:
              return 0;
            case 0x4001:
              return 1;
            default:
              return divisor;
          }
        };

        for (const request of [{
          requestType: 'vendor',
          recipient: 'device',
          request: FTDI_SIO_SET_BAUD_RATE,
          value: getDivisor(usbSerialPort_.serialOptions_.baudRate),
          index: baudBase,
        }, {
          requestType: 'vendor',
          recipient: 'device',
          request: FTDI_SIO_SET_LATENCY_TIMER,
          value: 32,
          index: 0,
        }] as USBControlTransferParameters[]) {
          if ((await usbSerialPort_.device_.controlTransferOut(
              request
          )).status !== 'ok') {
            throw new DOMException(
                'NetworkError', 'Failed to set line coding.'
            );
          }
        }

        // Logically a bit inconsistent solution, but the data characteristics are set
        // in setDataCharacteristics() along with the break status so we must call that
        // from two places.
        await this.setDataCharacteristics();
      }

      /**
       * Sets control signal state for the port.
       * @param {SerialOutputSignals} signals The signals to enable or disable.
       * @return {Promise<void>} a promise that is resolved when the signal state
       * has been changed.
       */
      public async setSignals(signals: SerialOutputSignals): Promise<void> {
        usbSerialPort_.outputSignals_ = {...usbSerialPort_.outputSignals_, ...signals};

        for (const request of [
          ...(signals.dataTerminalReady !== undefined ? [{
            requestType: 'vendor',
            recipient: 'device',
            request: FTDI_SIO_MODEM_CTRL,
            value: +signals.dataTerminalReady|0x100,
            index: 0,
          } as USBControlTransferParameters]:[]),
          ...(signals.requestToSend !== undefined ? [{
            requestType: 'vendor',
            recipient: 'device',
            request: FTDI_SIO_MODEM_CTRL,
            value: (+signals.requestToSend<<1)|0x200,
            index: 0,
          } as USBControlTransferParameters]:[]),
        ]) {
          if ((await usbSerialPort_.device_.controlTransferOut(
              request
          )).status !== 'ok') {
            throw new DOMException(
                'NetworkError', 'Failed to set signals.'
            );
          }
        }

        // Logically a bit inconsistent solution, but the break is set
        // in setDataCharacteristics() along with other values so we must
        // call that.
        await this.setDataCharacteristics();
      }
    };
  }


  /**
   * constructor taking a WebUSB device that creates a SerialPort instance.
   * @param {USBDevice} device A device acquired from the WebUSB API
   * @param {SerialPolyfillOptions} polyfillOptions Optional options to
   * configure the polyfill.
   */
  public constructor(
      device: USBDevice,
      polyfillOptions?: SerialPolyfillOptions) {
    this.polyfillOptions_ = polyfillOptionsWithDefaults(polyfillOptions);
    this.outputSignals_ = {
      dataTerminalReady: false,
      requestToSend: false,
      break: false,
    };

    this.protocol_ = new [
      this.UsbCdcAcmProtocol,
      this.UsbFtdiProtocol,
    ][this.polyfillOptions_.protocol||0]();

    this.device_ = device;
    this.controlInterface_ = findInterface(
        this.device_,
        this.polyfillOptions_.usbControlInterfaceClass as number);
    this.transferInterface_ = findInterface(
        this.device_,
        this.polyfillOptions_.usbTransferInterfaceClass as number);
    this.inEndpoint_ = findEndpoint(this.transferInterface_, 'in');
    this.outEndpoint_ = findEndpoint(this.transferInterface_, 'out');
  }

  /**
   * Getter for the readable attribute. Constructs a new ReadableStream as
   * necessary.
   * @return {ReadableStream} the current readable stream
   */
  public get readable(): ReadableStream<Uint8Array> | null {
    if (!this.readable_ && this.device_.opened) {
      this.readable_ = this.protocol_.createReadable(
        this.serialOptions_.bufferSize ??
        this.polyfillOptions_.defaultBufferSize ??
        0
      );
    }
    return this.readable_ || null;
  }

  /**
   * Getter for the writable attribute. Constructs a new WritableStream as
   * necessary.
   * @return {WritableStream} the current writable stream
   */
  public get writable(): WritableStream<Uint8Array> | null {
    if (!this.writable_ && this.device_.opened) {
      this.writable_ = this.protocol_.createWritable(
        this.serialOptions_.bufferSize ??
        this.polyfillOptions_.defaultBufferSize ??
        0
      );
    }
    return this.writable_ || null;
  }

  /**
   * a function that opens the device and claims all interfaces needed to
   * control and communicate to and from the serial device
   * @param {SerialOptions} options Object containing serial options
   * @return {Promise<void>} A promise that will resolve when device is ready
   * for communication
   */
  public async open(options: SerialOptions): Promise<void> {
    this.serialOptions_ = options;
    this.validateOptions();

    try {
      await this.device_.open();
      if (this.device_.configuration === null) {
        await this.device_.selectConfiguration(1);
      }
      await this.device_.claimInterface(this.controlInterface_.interfaceNumber);
      if (this.controlInterface_ !== this.transferInterface_) {
        await this.device_.claimInterface(
            this.transferInterface_.interfaceNumber);
      }

      await this.protocol_.setLineCoding();
      await this.protocol_.setSignals({dataTerminalReady: true});
    } catch (error) {
      if (this.device_.opened) {
        await this.device_.close();
      }
      throw new Error('Error setting up device: ' + error.toString());
    }
  }

  /**
   * Closes the port.
   *
   * @return {Promise<void>} A promise that will resolve when the port is
   * closed.
   */
  public async close(): Promise<void> {
    await Promise.all([
      this.readable_ && this.readable_.cancel().catch(()=>undefined),
      this.writable_ && this.writable_.abort().catch(()=>undefined),
    ]);
    this.readable_ = null;
    this.writable_ = null;
    if (this.device_.opened) {
      await this.protocol_.setSignals({dataTerminalReady: false, requestToSend: false});
      await this.device_.close();
    }
  }

  /**
   * A function that returns properties of the device.
   * @return {SerialPortInfo} Device properties.
   */
  public getInfo(): SerialPortInfo {
    return {
      usbVendorId: this.device_.vendorId,
      usbProductId: this.device_.productId,
    };
  }

  /**
   * A function used to change the serial settings of the device
   * @param {object} options the object which carries serial settings data
   * @return {Promise<void>} A promise that will resolve when the options are
   * set
   */
  public reconfigure(options: SerialOptions): Promise<void> {
    this.serialOptions_ = {...this.serialOptions_, ...options};
    this.validateOptions();
    return this.protocol_.setLineCoding();
  }

  /**
   * Sets control signal state for the port.
   * @param {SerialOutputSignals} signals The signals to enable or disable.
   * @return {Promise<void>} a promise that is resolved when the signal state
   * has been changed.
   */
  public async setSignals(signals: SerialOutputSignals): Promise<void> {
    this.protocol_.setSignals(signals);
  }

  /**
   * Checks the serial options for validity and throws an error if it is
   * not valid
   */
  private validateOptions(): void {
    if (!this.protocol_.isValidBaudRate(this.serialOptions_.baudRate)) {
      throw new RangeError('invalid Baud Rate ' + this.serialOptions_.baudRate);
    }

    if (!this.protocol_.isValidDataBits(this.serialOptions_.dataBits)) {
      throw new RangeError('invalid dataBits ' + this.serialOptions_.dataBits);
    }

    if (!this.protocol_.isValidStopBits(this.serialOptions_.stopBits)) {
      throw new RangeError('invalid stopBits ' + this.serialOptions_.stopBits);
    }

    if (!this.protocol_.isValidParity(this.serialOptions_.parity)) {
      throw new RangeError('invalid parity ' + this.serialOptions_.parity);
    }
  }

}

/** implementation of the global navigator.serial object */
class Serial {
  /**
   * Requests permission to access a new port.
   *
   * @param {SerialPortRequestOptions} options
   * @param {SerialPolyfillOptions} polyfillOptions
   * @return {Promise<SerialPort>}
   */
  async requestPort(
      options?: SerialPortRequestOptions,
      polyfillOptions?: SerialPolyfillOptions): Promise<SerialPort> {
    polyfillOptions = polyfillOptionsWithDefaults(polyfillOptions);
    const usbFilters: USBDeviceFilter[] = ((options||{}).filters||[{}])
        .map((filter:SerialPortFilter):USBDeviceFilter=>
          ({
            classCode: polyfillOptions?.usbDeviceClass,
            ...filter.usbVendorId && { vendorId: filter.usbVendorId },
            ...filter.usbProductId && { productId: filter.usbProductId },
          })
        );
    const device = await navigator.usb.requestDevice({'filters': usbFilters});
    const port = new SerialPort(device, polyfillOptions);
    return port;
  }

  /**
   * Get the set of currently available ports.
   *
   * @param {SerialPolyfillOptions} polyfillOptions Polyfill configuration that
   * should be applied to these ports.
   * @return {Promise<SerialPort[]>} a promise that is resolved with a list of
   * ports.
   */
  async getPorts(polyfillOptions?: SerialPolyfillOptions):
      Promise<SerialPort[]> {
    polyfillOptions = polyfillOptionsWithDefaults(polyfillOptions);

    const devices = await navigator.usb.getDevices();
    const ports: SerialPort[] = [];
    devices.forEach((device) => {
      try {
        const port = new SerialPort(device, polyfillOptions);
        ports.push(port);
      } catch (e) {
        // Skip unrecognized port.
      }
    });
    return ports;
  }
}

/* an object to be used for starting the serial workflow */
export const serial = new Serial();
